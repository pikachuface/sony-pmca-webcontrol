import type { CaptureSettings, CaptureSettingsPatch } from '../api/cameraClient';

interface QualityPanelProps {
  connected: boolean;
  settings?: CaptureSettings;
  /** Mode the settings are remembered for, shown as a hint. */
  modeLabel: string;
  /** Last stored file size per type ('arw', 'jpg'), measured from the card. */
  lastSizes: Record<string, number>;
  busy: boolean;
  /** Changing quality during a timelapse would mix formats in one series. */
  locked: boolean;
  onChange: (patch: CaptureSettingsPatch) => void;
}

const FORMAT_LABELS: Record<string, string> = { raw: 'RAW', jpeg: 'JPEG', rawjpeg: 'RAW+JPEG' };
const FORMAT_ORDER = ['raw', 'rawjpeg', 'jpeg'];
// The ILCE-7 lists 95, 50, 25 for its three menu entries Extra fine, Fine and Standard.
const QUALITY_LABELS: Record<string, string> = { '95': 'Extra fine', '50': 'Fine', '25': 'Standard' };
const SIZE_LABELS: Record<string, string> = { large: 'L', midium: 'M', small: 'S' };

export function formatLabel(format?: string): string {
  if (!format) return '--';
  return FORMAT_LABELS[format] ?? format;
}

export function qualityLabel(q?: string): string {
  if (!q) return '--';
  return QUALITY_LABELS[q] ?? q;
}

export function hasJpeg(format?: string): boolean {
  return format === 'jpeg' || format === 'rawjpeg';
}

export function hasRaw(format?: string): boolean {
  return format === 'raw' || format === 'rawjpeg';
}

function formatMB(bytes?: number): string | null {
  return bytes ? `${(bytes / 1e6).toFixed(1)} MB` : null;
}

function sortBy(values: string[] | undefined, order: string[]): string[] {
  const list = values ?? [];
  return [...list].sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
}

function Segmented({
  label,
  values,
  current,
  names,
  disabled,
  onPick,
}: {
  label: string;
  values: string[];
  current?: string;
  names: Record<string, string>;
  disabled: boolean;
  onPick: (v: string) => void;
}) {
  if (values.length === 0) return null;
  return (
    <div className="quality-row">
      <span className="quality-label">{label}</span>
      <div className="segmented" role="group" aria-label={label}>
        {values.map((v) => (
          <button
            key={v}
            type="button"
            className={`segmented-btn ${current === v ? 'is-active' : ''}`}
            aria-pressed={current === v}
            disabled={disabled}
            onClick={() => current !== v && onPick(v)}
          >
            {names[v] ?? v}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Still image quality: RAW / JPEG / RAW+JPEG, JPEG quality, size and aspect, written to the
 * camera with highlevel.setCaptureSettings. Best the ILCE-7 offers: RAW+JPEG, Extra fine, L 3:2.
 */
export function QualityPanel({ connected, settings, modeLabel, lastSizes, busy, locked, onChange }: QualityPanelProps) {
  const disabled = !connected || busy || locked || !settings;
  const jpeg = hasJpeg(settings?.format);
  const sizes = [
    hasRaw(settings?.format) && formatMB(lastSizes.arw) ? `ARW ${formatMB(lastSizes.arw)}` : null,
    jpeg && formatMB(lastSizes.jpg) ? `JPG ${formatMB(lastSizes.jpg)}` : null,
  ].filter(Boolean);

  return (
    <section className="panel">
      <div className="panel-header">
        <div className="panel-title">
          <span>Quality</span>
          {settings?.format && (
            <span className="badge">
              {formatLabel(settings.format)}
              {jpeg ? ` · ${qualityLabel(settings.jpegQuality)}` : ''}
            </span>
          )}
          {busy && <span className="muted-tag">setting…</span>}
        </div>
      </div>

      {!settings ? (
        <p className="quality-note">{connected ? 'Reading quality from the camera…' : 'Not connected.'}</p>
      ) : (
        <>
          <Segmented
            label="Format"
            values={sortBy(settings.formatValues, FORMAT_ORDER)}
            current={settings.format}
            names={FORMAT_LABELS}
            disabled={disabled}
            onPick={(v) => onChange({ format: v })}
          />
          <Segmented
            label="JPEG"
            values={settings.jpegQualityValues ?? []}
            current={settings.jpegQuality}
            names={QUALITY_LABELS}
            disabled={disabled || !jpeg}
            onPick={(v) => onChange({ jpegQuality: v })}
          />
          <Segmented
            label="Size"
            values={settings.imageSizeValues ?? []}
            current={settings.imageSize}
            names={SIZE_LABELS}
            disabled={disabled || !jpeg}
            onPick={(v) => onChange({ imageSize: v })}
          />
          <Segmented
            label="Aspect"
            values={settings.aspectValues ?? []}
            current={settings.aspect}
            names={{}}
            disabled={disabled || !jpeg}
            onPick={(v) => onChange({ aspect: v })}
          />
          <p className="quality-note">
            {jpeg && settings.pictureSize ? `JPEG ${settings.pictureSize.replace('x', '×')}. ` : ''}
            {hasRaw(settings.format) ? 'RAW is always full size. ' : ''}
            {sizes.length > 0 ? `Last shot: ${sizes.join(', ')}. ` : ''}
            {locked ? 'Locked while the timelapse runs.' : `Remembered for ${modeLabel} mode.`}
          </p>
        </>
      )}
    </section>
  );
}
