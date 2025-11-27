# google-drive-to-wp-media-sync

Google Drive to WP Media Sync pairs a Google Apps Script with a WordPress plugin to stream product assets straight from Drive into the WordPress media library. The script batches Drive files, resumes automatically, and sends base64 payloads over HTTPS.

A two-part solution for mirroring Google Drive folders into the WordPress media library:

1. **Google Apps Script (`apps-script/google-drive-to-wp-media-sync.gs`)** – batches Drive files, resumes automatically, and posts them to a secure REST endpoint.
2. **WordPress plugin (`wordpress-plugin/google-drive-media-sync`)** – registers the `drive-sync/v1/upload` endpoint, validates a shared token, and sideloads files into Media Library.

## Workflow
1. Install the WordPress plugin and copy the generated sync token (Settings → Drive Media Sync).
2. Create script properties inside Google Apps Script:
   - `WP_BASE_URL` – e.g. `https://example.com`
   - `SYNC_TOKEN` – token from the plugin settings
   - `MAIN_FOLDER_ID` – Google Drive folder ID that contains product folders
   - Optional tuning: `IMAGE_EXTENSIONS`, `PDF_EXTENSIONS`, `BATCH_SIZE`, `MAX_RUNTIME_MS`, `RESUME_DELAY_MS`, `MEMORY_CLEANUP_INTERVAL`, `DEBUG_MODE`, `REST_PATH`
3. Paste the Apps Script file in your Drive project and run `scanAndUpload`.
4. The script processes files in batches, saves progress, resumes automatically, and logs the uploaded media URLs returned by WordPress.

## WordPress Plugin Highlights
- Stores a random sync token (regenerable from the admin settings page).
- Exposes `POST /wp-json/drive-sync/v1/upload` accepting `{fileName, mimeType, category, fileData}`.
- Handles dry-run checks by returning HTTP 202 responses.
- Uses `media_handle_sideload` for proper attachment metadata and thumbnails.

## Development
```
├── apps-script/
│   └── google-drive-to-wp-media-sync.gs
└── wordpress-plugin/
    └── google-drive-media-sync/
        └── google-drive-media-sync.php
```
