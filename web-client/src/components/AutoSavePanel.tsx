import { isDirectoryPickerSupported } from '../api/localSave';
import { hasJpeg, hasRaw } from './QualityPanel';

/** Where a photo ends up: the camera always stores to the card; "sdpc" also downloads it. */
export type SaveDest = 'sd' | 'sdpc';
/** Which stored files of a RAW+JPEG shot are downloaded to the PC. */
export type PcFiles = 'all' | 'jpeg' | 'raw';

interface AutoSavePanelProps {
  dest: SaveDest;
  onDestChange: (dest: SaveDest) => void;
  pcFiles: PcFiles;
  onPcFilesChange: (files: PcFiles) => void;
  /** Camera storage format (raw, jpeg, rawjpeg), to offer only the file types it stores. */
  format?: string;
  dirName: string | null;
  onPickDirectory: () => void;
  savedCount: number;
  queued: number;
  lastSavedFile: string | null;
  savingStatus: string | null;
  connected: boolean;
  getLatestPhotoUrl: (inline?: boolean) => string;
  onOpenSavedPhoto?: () => void;
}

const DEST_LABELS: Record<SaveDest, string> = { sd: 'SD card', sdpc: 'SD + PC' };
const PC_FILES_LABELS: Record<PcFiles, string> = { all: 'RAW + JPEG', jpeg: 'JPEG', raw: 'RAW' };

export function AutoSavePanel({
  dest,
  onDestChange,
  pcFiles,
  onPcFilesChange,
  format,
  dirName,
  onPickDirectory,
  savedCount,
  queued,
  lastSavedFile,
  savingStatus,
  connected,
  getLatestPhotoUrl,
  onOpenSavedPhoto,
}: AutoSavePanelProps) {
  const pickerSupported = isDirectoryPickerSupported();
  const toPc = dest === 'sdpc';
  const both = hasRaw(format) && hasJpeg(format);

  return (
    <section className="panel">
      <div className="panel-header">
        <div className="panel-title">
          <span>Save</span>
          {savedCount > 0 && <span className="badge">{savedCount} on PC</span>}
          {queued > 0 && <span className="muted-tag">{queued} queued</span>}
        </div>
        <div className="toolbar-row">
          <a
            className={`btn btn-sm ${!connected ? 'is-disabled' : ''}`}
            href={connected ? getLatestPhotoUrl(true) : '#'}
            target="_blank"
            rel="noopener noreferrer"
            title="View the latest photo (camera's JPEG) in a new tab"
            aria-label="View latest photo"
            aria-disabled={!connected}
            style={!connected ? { opacity: 0.5, pointerEvents: 'none' } : undefined}
            onClick={(e) => {
              if (!connected) {
                e.preventDefault();
                return;
              }
              e.currentTarget.href = getLatestPhotoUrl(true);
            }}
          >
            View Latest
          </a>
        </div>
      </div>

      <div className="quality-row">
        <span className="quality-label">Save to</span>
        <div className="segmented" role="group" aria-label="Save photos to">
          {(Object.keys(DEST_LABELS) as SaveDest[]).map((d) => (
            <button
              key={d}
              type="button"
              className={`segmented-btn ${dest === d ? 'is-active' : ''}`}
              aria-pressed={dest === d}
              onClick={() => onDestChange(d)}
            >
              {DEST_LABELS[d]}
            </button>
          ))}
        </div>
      </div>

      {toPc && both && (
        <div className="quality-row">
          <span className="quality-label">To PC</span>
          <div className="segmented" role="group" aria-label="Files downloaded to the PC">
            {(Object.keys(PC_FILES_LABELS) as PcFiles[]).map((f) => (
              <button
                key={f}
                type="button"
                className={`segmented-btn ${pcFiles === f ? 'is-active' : ''}`}
                aria-pressed={pcFiles === f}
                onClick={() => onPcFilesChange(f)}
              >
                {PC_FILES_LABELS[f]}
              </button>
            ))}
          </div>
        </div>
      )}

      <p className="quality-note">
        {toPc
          ? 'Each shot is stored on the card, then its files are downloaded in full quality over Wi‑Fi (about 2.3 MB/s, so a 25 MB RAW takes about 11 s). Keep this tab open.'
          : 'Shots stay on the SD card only.'}
      </p>

      {toPc && (
        <div className="autosave-row">
          <div>
            {pickerSupported ? (
              <button
                type="button"
                className={`btn btn-sm ${!dirName ? 'btn-primary' : ''}`}
                onClick={onPickDirectory}
                title="Choose the local folder for downloaded photos"
              >
                {dirName ? `Folder: ${dirName}` : 'Choose Folder'}
              </button>
            ) : (
              <span className="muted-tag">Browser downloads (the folder picker needs HTTPS or localhost)</span>
            )}
          </div>
          {savingStatus ? (
            <span className="autosave-status" title={savingStatus}>
              {savingStatus}
            </span>
          ) : (
            lastSavedFile && (
              <span className="autosave-status" title={`Saved: ${lastSavedFile}`}>
                {'Saved: '}
                {onOpenSavedPhoto ? (
                  <button
                    type="button"
                    className="autosave-link"
                    onClick={onOpenSavedPhoto}
                    title={`Open local file ${lastSavedFile} in a new tab`}
                  >
                    {lastSavedFile}
                  </button>
                ) : (
                  lastSavedFile
                )}
              </span>
            )
          )}
        </div>
      )}
    </section>
  );
}
