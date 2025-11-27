<?php
/**
 * Plugin Name: Google Drive Media Sync
 * Description: Secure REST endpoint that receives Google Drive uploads and inserts them into the WordPress media library.
 * Version: 1.0.0
 * Author: Lucas Dijk
 * License: GPL-3.0-or-later
 */

if (!defined('ABSPATH')) {
    exit;
}

const GDM_OPTION_TOKEN = 'gdm_sync_token';

register_activation_hook(__FILE__, function () {
    if (!get_option(GDM_OPTION_TOKEN)) {
        update_option(GDM_OPTION_TOKEN, wp_generate_password(40, false, false));
    }
});

add_action('admin_menu', function () {
    add_options_page(
        __('Drive Media Sync', 'gdm'),
        __('Drive Media Sync', 'gdm'),
        'manage_options',
        'gdm-settings',
        'gdm_render_settings_page'
    );
});

function gdm_render_settings_page()
{
    if (!current_user_can('manage_options')) {
        return;
    }

    if (isset($_POST['gdm_regenerate_nonce']) && wp_verify_nonce($_POST['gdm_regenerate_nonce'], 'gdm_regenerate_token')) {
        update_option(GDM_OPTION_TOKEN, wp_generate_password(40, false, false));
        add_settings_error('gdm_messages', 'gdm_token_regenerated', __('Sync token regenerated.', 'gdm'), 'updated');
    }

    settings_errors('gdm_messages');
    $token = esc_html(get_option(GDM_OPTION_TOKEN));
    $endpoint = esc_url(rest_url('drive-sync/v1/upload'));
    ?>
    <div class="wrap">
        <h1><?php esc_html_e('Drive Media Sync', 'gdm'); ?></h1>
        <p><?php esc_html_e('Provide this token to your Google Apps Script workflow. Requests with an invalid token are rejected.', 'gdm'); ?></p>
        <table class="form-table" role="presentation">
            <tr>
                <th scope="row"><?php esc_html_e('REST Endpoint', 'gdm'); ?></th>
                <td><code><?php echo $endpoint; ?></code></td>
            </tr>
            <tr>
                <th scope="row"><?php esc_html_e('Sync Token', 'gdm'); ?></th>
                <td><code><?php echo $token; ?></code></td>
            </tr>
        </table>
        <form method="post">
            <?php wp_nonce_field('gdm_regenerate_token', 'gdm_regenerate_nonce'); ?>
            <p>
                <button type="submit" class="button button-secondary"><?php esc_html_e('Regenerate Token', 'gdm'); ?></button>
            </p>
        </form>
    </div>
    <?php
}

add_action('rest_api_init', function () {
    register_rest_route('drive-sync/v1', '/upload', [
        'methods'  => WP_REST_Server::CREATABLE,
        'callback' => 'gdm_handle_upload',
        'permission_callback' => 'gdm_verify_request',
        'args' => [
            'fileName' => [
                'type' => 'string',
                'required' => true,
            ],
            'mimeType' => [
                'type' => 'string',
                'required' => true,
            ],
            'fileData' => [
                'type' => 'string',
                'required' => true,
            ],
            'category' => [
                'type' => 'string',
                'required' => false,
                'default' => '',
            ],
            'dryRun' => [
                'type' => 'boolean',
                'required' => false,
                'default' => false,
            ],
        ],
    ]);
});

function gdm_verify_request(WP_REST_Request $request)
{
    $provided = $request->get_header('x-drive-sync-token');
    $stored = get_option(GDM_OPTION_TOKEN);
    if (!$provided || !$stored || !hash_equals($stored, $provided)) {
        return new WP_Error('gdm_invalid_token', __('Invalid or missing sync token.', 'gdm'), ['status' => 401]);
    }
    return true;
}

function gdm_handle_upload(WP_REST_Request $request)
{
    if ($request['dryRun']) {
        return new WP_REST_Response(['message' => 'Dry run acknowledged'], 202);
    }

    $file_name = sanitize_file_name($request['fileName']);
    $mime_type = sanitize_text_field($request['mimeType']);
    $category = sanitize_text_field($request['category']);
    $encoded = $request['fileData'];
    $file_bits = base64_decode($encoded, true);

    if (false === $file_bits) {
        return new WP_Error('gdm_invalid_payload', __('fileData must be valid base64.', 'gdm'), ['status' => 400]);
    }

    $temp = wp_tempnam($file_name ?: 'drive-upload');
    if (!$temp) {
        return new WP_Error('gdm_temp_error', __('Unable to create temporary file.', 'gdm'), ['status' => 500]);
    }

    file_put_contents($temp, $file_bits);

    require_once ABSPATH . 'wp-admin/includes/file.php';
    require_once ABSPATH . 'wp-admin/includes/media.php';
    require_once ABSPATH . 'wp-admin/includes/image.php';

    $file_array = [
        'name' => $file_name ?: basename($temp),
        'tmp_name' => $temp,
        'type' => $mime_type,
    ];

    $attachment_id = media_handle_sideload($file_array, 0, $category, ['post_mime_type' => $mime_type]);

    if (is_wp_error($attachment_id)) {
        @unlink($temp);
        return $attachment_id;
    }

    $url = wp_get_attachment_url($attachment_id);

    return new WP_REST_Response([
        'attachment_id' => $attachment_id,
        'url' => $url,
        'category' => $category,
    ], 201);
}
