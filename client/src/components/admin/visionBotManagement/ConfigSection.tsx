import React from 'react';
import { VisionBotConfig } from './types';

interface ConfigSectionProps {
  fieldValue: <K extends keyof VisionBotConfig>(key: K) => VisionBotConfig[K] | undefined;
  setDraftField: <K extends keyof VisionBotConfig>(key: K, value: VisionBotConfig[K]) => void;
  commitField: <K extends keyof VisionBotConfig>(key: K) => void;
  onToggleUrlRelay: (checked: boolean) => void;
}

const ConfigSection: React.FC<ConfigSectionProps> = ({
  fieldValue,
  setDraftField,
  commitField,
  onToggleUrlRelay,
}) => (
  <div className="vb-section">
    <h3>Configuration</h3>
    <div className="vb-config-grid">
      <label className="vb-field">
        <span>Frequency (s)</span>
        <input
          type="number"
          min={60}
          max={3600}
          value={fieldValue('transcription_frequency_s') ?? ''}
          onChange={e => setDraftField('transcription_frequency_s', parseInt(e.target.value, 10))}
          onBlur={() => commitField('transcription_frequency_s')}
        />
        <small>Seconds between vision cycles (min 60).</small>
      </label>

      <label className="vb-field">
        <span>Audio window (s)</span>
        <input
          type="number"
          min={10}
          max={120}
          value={fieldValue('transcription_duration_s') ?? ''}
          onChange={e => setDraftField('transcription_duration_s', parseInt(e.target.value, 10))}
          onBlur={() => commitField('transcription_duration_s')}
        />
        <small>How much spoken audio precedes each frame (10–120).</small>
      </label>

      <label className="vb-field">
        <span>Image resolution (px)</span>
        <input
          type="number"
          min={128}
          max={1024}
          value={fieldValue('image_resolution_px') ?? ''}
          onChange={e => setDraftField('image_resolution_px', parseInt(e.target.value, 10))}
          onBlur={() => commitField('image_resolution_px')}
        />
        <small>Long edge of the captured JPEG.</small>
      </label>

      <label className="vb-field">
        <span>Image quality (1–100)</span>
        <input
          type="number"
          min={10}
          max={100}
          value={fieldValue('image_quality') ?? ''}
          onChange={e => setDraftField('image_quality', parseInt(e.target.value, 10))}
          onBlur={() => commitField('image_quality')}
        />
        <small>JPEG quality. Lower = smaller payload to Groq.</small>
      </label>

      <label className="vb-field">
        <span>Vision model</span>
        <input
          type="text"
          value={fieldValue('vision_model') ?? ''}
          onChange={e => setDraftField('vision_model', e.target.value)}
          onBlur={() => commitField('vision_model')}
          placeholder="meta-llama/llama-4-scout-17b-16e-instruct"
        />
        <small>Groq vision-capable model id.</small>
      </label>

      <label className="vb-field">
        <span>Max response tokens</span>
        <input
          type="number"
          min={20}
          max={500}
          value={fieldValue('max_response_tokens') ?? ''}
          onChange={e => setDraftField('max_response_tokens', parseInt(e.target.value, 10))}
          onBlur={() => commitField('max_response_tokens')}
        />
        <small>Hard cap on the comment length the model can emit.</small>
      </label>

      <label className="vb-field">
        <span>Temperature</span>
        <input
          type="number"
          step="0.1"
          min={0}
          max={2}
          value={fieldValue('temperature') ?? ''}
          onChange={e => setDraftField('temperature', parseFloat(e.target.value))}
          onBlur={() => commitField('temperature')}
        />
        <small>0 = deterministic, 1 = balanced, 2 = chaotic.</small>
      </label>

      <label className="vb-field">
        <span>Bots per cycle</span>
        <input
          type="number"
          min={1}
          max={5}
          value={fieldValue('max_bots_per_cycle') ?? ''}
          onChange={e => setDraftField('max_bots_per_cycle', parseInt(e.target.value, 10))}
          onBlur={() => commitField('max_bots_per_cycle')}
        />
        <small>How many vision-enabled bots dispatch per cycle (1–5).</small>
      </label>

      <label className="vb-field">
        <span>Frame retention (hours)</span>
        <input
          type="number"
          min={0}
          max={24}
          value={fieldValue('frame_retention_hours') ?? ''}
          onChange={e => setDraftField('frame_retention_hours', parseInt(e.target.value, 10))}
          onBlur={() => commitField('frame_retention_hours')}
        />
        <small>Captured JPEGs are kept this long for audit; flagged frames are kept separately for 30 days.</small>
      </label>

      <label className="vb-field vb-field-checkbox">
        <input
          type="checkbox"
          checked={fieldValue('allow_url_relay') === true}
          onChange={e => onToggleUrlRelay(e.target.checked)}
        />
        <span>Allow vision cycles during URL-relay streams</span>
        <small>Default off &mdash; relayed streams have unknown copyright/audit exposure.</small>
      </label>
    </div>
  </div>
);

export default ConfigSection;
