const runtime = { config: null };

function loadConfig() {
  const props = PropertiesService.getScriptProperties();
  const requiredKeys = [
    'WP_BASE_URL',
    'SYNC_TOKEN',
    'MAIN_FOLDER_ID'
  ];
  const config = {
    IMAGE_EXTENSIONS: normalizeList(props.getProperty('IMAGE_EXTENSIONS'), 'png,jpg,jpeg,gif,webp'),
    PDF_EXTENSIONS: normalizeList(props.getProperty('PDF_EXTENSIONS'), 'pdf'),
    BATCH_SIZE: parseInt(props.getProperty('BATCH_SIZE') || '10', 10),
    MAX_RUNTIME: parseInt(props.getProperty('MAX_RUNTIME_MS') || String(5 * 60 * 1000), 10),
    RESUME_DELAY: parseInt(props.getProperty('RESUME_DELAY_MS') || String(2 * 60 * 1000), 10),
    MEMORY_CLEANUP_INTERVAL: parseInt(props.getProperty('MEMORY_CLEANUP_INTERVAL') || '20', 10),
    DEBUG_MODE: (props.getProperty('DEBUG_MODE') || 'false').toLowerCase() === 'true',
    REST_PATH: props.getProperty('REST_PATH') || '/wp-json/drive-sync/v1/upload'
  };
  requiredKeys.forEach(key => {
    const value = props.getProperty(key);
    if (!value) {
      throw new Error(`Missing config value for ${key}`);
    }
    config[key] = value.trim();
  });
  return config;
}

function normalizeList(value, fallback) {
  return (value || fallback)
    .split(',')
    .map(entry => entry.trim().toLowerCase())
    .filter(Boolean);
}

function getConfig() {
  if (!runtime.config) {
    runtime.config = loadConfig();
  }
  return runtime.config;
}

function scanAndUpload() {
  const cfg = getConfig();
  const props = PropertiesService.getScriptProperties();
  const startTime = Date.now();
  let folderIndex = parseInt(props.getProperty('folderIndex') || '0', 10);
  let fileIndex = parseInt(props.getProperty('fileIndex') || '0', 10);
  let totalUploaded = parseInt(props.getProperty('totalUploaded') || '0', 10);
  let totalFailed = parseInt(props.getProperty('totalFailed') || '0', 10);
  const isResume = folderIndex > 0 || fileIndex > 0;
  Logger.log('Starting Google Drive → WordPress Media sync');
  if (!isResume && !testSyncEndpoint(cfg)) {
    Logger.log('Authentication failed, aborting');
    return;
  }
  const rootFolder = DriveApp.getFolderById(cfg.MAIN_FOLDER_ID);
  const folders = [];
  const folderIterator = rootFolder.getFolders();
  while (folderIterator.hasNext()) {
    folders.push(folderIterator.next());
  }
  if (!folders.length) {
    Logger.log('No folders found under main folder');
    return;
  }
  let filesSinceCleanup = 0;
  for (let i = folderIndex; i < folders.length; i++) {
    const categoryFolder = folders[i];
    const fileIds = getAllFileIdsInFolder(categoryFolder, cfg);
    if (!fileIds.length) {
      fileIndex = 0;
      saveMinimalProgress(i + 1, 0, totalUploaded, totalFailed);
      continue;
    }
    for (let j = fileIndex; j < fileIds.length; j += cfg.BATCH_SIZE) {
      const elapsed = Date.now() - startTime;
      if (elapsed > cfg.MAX_RUNTIME) {
        saveMinimalProgress(i, j, totalUploaded, totalFailed);
        Logger.log('Execution window reached, scheduling resume');
        createResumeTrigger(cfg.RESUME_DELAY);
        return;
      }
      const batchEnd = Math.min(j + cfg.BATCH_SIZE, fileIds.length);
      const batch = fileIds.slice(j, batchEnd);
      const stats = processBatch(batch, categoryFolder.getName(), cfg);
      totalUploaded += stats.uploaded;
      totalFailed += stats.failed;
      saveMinimalProgress(i, batchEnd, totalUploaded, totalFailed);
      filesSinceCleanup += batch.length;
      if (filesSinceCleanup >= cfg.MEMORY_CLEANUP_INTERVAL) {
        forceMemoryCleanup();
        filesSinceCleanup = 0;
      }
      Utilities.sleep(2000);
    }
    fileIndex = 0;
    saveMinimalProgress(i + 1, 0, totalUploaded, totalFailed);
    forceMemoryCleanup();
  }
  clearProgress();
  deleteResumeTriggers();
  Logger.log(`Sync complete. Uploaded: ${totalUploaded}, Failed: ${totalFailed}`);
}

function processBatch(fileIds, categoryName, cfg) {
  let uploaded = 0;
  let failed = 0;
  fileIds.forEach((fileId, index) => {
    try {
      let file = DriveApp.getFileById(fileId);
      const result = uploadSingleFile(file, categoryName, cfg);
      if (result.success) {
        uploaded++;
        if (cfg.DEBUG_MODE) {
          Logger.log(`Uploaded ${file.getName()} (${index + 1}/${fileIds.length}) → ${result.url}`);
        }
      } else {
        failed++;
        Logger.log(`Failed ${file.getName()}: ${result.error}`);
      }
      file = null;
    } catch (error) {
      failed++;
      Logger.log(`Error uploading ${fileId}: ${error.message}`);
    }
    Utilities.sleep(1000);
  });
  return { uploaded, failed };
}

function uploadSingleFile(file, categoryName, cfg) {
  try {
    const fileName = file.getName();
    const blob = file.getBlob();
    blob.setName(fileName);
    const payload = {
      fileName,
      mimeType: file.getMimeType(),
      category: categoryName,
      fileData: Utilities.base64Encode(blob.getBytes())
    };
    const response = UrlFetchApp.fetch(`${cfg.WP_BASE_URL}${cfg.REST_PATH}`, {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'X-Drive-Sync-Token': cfg.SYNC_TOKEN
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    if (response.getResponseCode() === 201) {
      const body = JSON.parse(response.getContentText());
      return { success: true, mediaId: body.attachment_id, url: body.url };
    }
    const errorPayload = response.getContentText();
    let message = 'Unknown error';
    try {
      const errorBody = JSON.parse(errorPayload);
      message = errorBody.message || errorBody.code || errorPayload.substring(0, 120);
    } catch (e) {
      message = errorPayload.substring(0, 120);
    }
    return { success: false, error: message };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function getAllFileIdsInFolder(folder, cfg) {
  const ids = [];
  (function scan(current) {
    const files = current.getFiles();
    while (files.hasNext()) {
      const file = files.next();
      const name = file.getName().toLowerCase();
      const extension = name.split('.').pop();
      if (cfg.IMAGE_EXTENSIONS.includes(extension) || cfg.PDF_EXTENSIONS.includes(extension)) {
        ids.push(file.getId());
      }
    }
    const children = current.getFolders();
    while (children.hasNext()) {
      scan(children.next());
    }
  })(folder);
  return ids;
}

function forceMemoryCleanup() {
  let buffer = new Array(1000);
  for (let i = 0; i < buffer.length; i++) {
    buffer[i] = null;
  }
  buffer = null;
  Utilities.sleep(100);
}

function saveMinimalProgress(folderIndex, fileIndex, totalUploaded, totalFailed) {
  const props = PropertiesService.getScriptProperties();
  props.setProperty('folderIndex', folderIndex.toString());
  props.setProperty('fileIndex', fileIndex.toString());
  props.setProperty('totalUploaded', totalUploaded.toString());
  props.setProperty('totalFailed', totalFailed.toString());
}

function createResumeTrigger(delayMs) {
  deleteResumeTriggers();
  ScriptApp.newTrigger('scanAndUpload').timeBased().after(delayMs).create();
}

function deleteResumeTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(trigger => {
    if (trigger.getHandlerFunction() === 'scanAndUpload') {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

function clearProgress() {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty('folderIndex');
  props.deleteProperty('fileIndex');
  props.deleteProperty('totalUploaded');
  props.deleteProperty('totalFailed');
}

function resetProgress() {
  clearProgress();
  deleteResumeTriggers();
  Logger.log('Progress reset');
}

function checkProgress() {
  const props = PropertiesService.getScriptProperties();
  const folderIndex = parseInt(props.getProperty('folderIndex') || '0', 10) + 1;
  const fileIndex = parseInt(props.getProperty('fileIndex') || '0', 10) + 1;
  const totalUploaded = props.getProperty('totalUploaded') || '0';
  const totalFailed = props.getProperty('totalFailed') || '0';
  Logger.log(`Folder: ${folderIndex}`);
  Logger.log(`File: ${fileIndex}`);
  Logger.log(`Uploaded: ${totalUploaded}`);
  Logger.log(`Failed: ${totalFailed}`);
}

function emergencyCleanup() {
  const props = PropertiesService.getScriptProperties();
  props.deleteAllProperties();
  deleteResumeTriggers();
  Logger.log('Emergency cleanup complete');
}

function listFolders() {
  const cfg = getConfig();
  const root = DriveApp.getFolderById(cfg.MAIN_FOLDER_ID);
  const folders = root.getFolders();
  let count = 0;
  while (folders.hasNext()) {
    const folder = folders.next();
    const fileIds = getAllFileIdsInFolder(folder, cfg);
    Logger.log(`${++count}. ${folder.getName()} (${fileIds.length} files)`);
  }
}

function testSingleUpload() {
  const cfg = getConfig();
  const root = DriveApp.getFolderById(cfg.MAIN_FOLDER_ID);
  const folders = root.getFolders();
  if (!folders.hasNext()) {
    Logger.log('No folders available');
    return;
  }
  const folder = folders.next();
  const files = folder.getFiles();
  if (!files.hasNext()) {
    Logger.log('No files available');
    return;
  }
  const file = files.next();
  Logger.log(`Uploading ${file.getName()}`);
  const result = uploadSingleFile(file, folder.getName(), cfg);
  if (result.success) {
    Logger.log(`Uploaded successfully: ${result.url}`);
  } else {
    Logger.log(`Upload failed: ${result.error}`);
  }
}

function testBatchUpload() {
  const cfg = getConfig();
  const root = DriveApp.getFolderById(cfg.MAIN_FOLDER_ID);
  const folders = root.getFolders();
  if (!folders.hasNext()) {
    Logger.log('No folders available');
    return;
  }
  const folder = folders.next();
  const fileIds = getAllFileIdsInFolder(folder, cfg).slice(0, cfg.BATCH_SIZE);
  if (!fileIds.length) {
    Logger.log('No files available');
    return;
  }
  const result = processBatch(fileIds, folder.getName(), cfg);
  Logger.log(`Test batch uploaded ${result.uploaded}, failed ${result.failed}`);
}

function testSyncEndpoint(cfg) {
  try {
    const response = UrlFetchApp.fetch(`${cfg.WP_BASE_URL}${cfg.REST_PATH}`, {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'X-Drive-Sync-Token': cfg.SYNC_TOKEN
      },
      payload: JSON.stringify({
        dryRun: true,
        fileName: 'connectivity-check.txt',
        mimeType: 'text/plain',
        category: 'connectivity',
        fileData: Utilities.base64Encode(Utilities.newBlob('drive-sync-check').getBytes())
      }),
      muteHttpExceptions: true
    });
    return response.getResponseCode() === 202;
  } catch (error) {
    Logger.log(`Sync endpoint error: ${error.message}`);
    return false;
  }
}
