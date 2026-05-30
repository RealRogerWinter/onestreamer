import React from 'react';
import './VisionBotManagement.css';
import { useVisionBotData } from './visionBotManagement/useVisionBotData';
import StatusSection from './visionBotManagement/StatusSection';
import StatsSection from './visionBotManagement/StatsSection';
import PromptSection from './visionBotManagement/PromptSection';
import ConfigSection from './visionBotManagement/ConfigSection';
import PerBotSection from './visionBotManagement/PerBotSection';
import LogsModal from './visionBotManagement/LogsModal';

interface Props {
  addLog: (message: string) => void;
}

const VisionBotManagement: React.FC<Props> = ({ addLog }) => {
  const vb = useVisionBotData(addLog);
  const {
    status,
    fetchError,
    busy,
    logs,
    logsOpen,
    setLogsOpen,
    promptDraft,
    setPromptDraft,
    promptEditing,
    setPromptEditing,
    setDraft,
    fetchStatus,
    fetchLogs,
    enable,
    disable,
    pushConfig,
    savePrompt,
    cancelPrompt,
    togglePerBotVision,
    fieldValue,
    setDraftField,
    commitField,
    visionEligibleBots,
    visionEnabledCount,
    cyclesAttempted,
    cyclesSucceeded,
    successPct,
  } = vb;

  return (
    <div className="visionbot-management">
      <div className="visionbot-header">
        <h2>👁️ VisionBot &mdash; AI Frame Commentary</h2>
        <p className="visionbot-subtitle">
          Periodically samples a frame from the live egress recording, pairs it with
          the most recent transcription, and asks vision-enabled chatbots to react.
        </p>
      </div>

      {fetchError && (
        <div className="vb-banner vb-banner-error">
          ⚠️ Could not reach the VisionBot service: <code>{fetchError}</code>.
          Confirm the <code>x-admin-key</code> in <code>localStorage.adminKey</code> is set.
        </div>
      )}

      {status?.kill_switch_env && (
        <div className="vb-banner vb-banner-warn">
          🛑 <strong>VISIONBOT_KILL_SWITCH=1</strong> is set in the server environment.
          All cycles will drop with reason <code>kill_switch</code> regardless of
          enable state.
        </div>
      )}

      {/* Service status header */}
      <StatusSection
        status={status}
        busy={busy}
        visionEnabledCount={visionEnabledCount}
        visionEligibleCount={visionEligibleBots.length}
        onEnable={enable}
        onDisable={disable}
        onOpenLogs={() => { setLogsOpen(true); }}
        onRefresh={() => fetchStatus()}
      />

      {/* Stats */}
      <StatsSection
        status={status}
        cyclesAttempted={cyclesAttempted}
        cyclesSucceeded={cyclesSucceeded}
        successPct={successPct}
      />

      {/* Prompt editor */}
      <PromptSection
        status={status}
        promptDraft={promptDraft}
        promptEditing={promptEditing}
        onPromptDraftChange={setPromptDraft}
        onBeginEdit={() => {
          setPromptDraft(status?.config?.vision_prompt_template || '');
          setPromptEditing(true);
        }}
        onSave={savePrompt}
        onCancel={cancelPrompt}
      />

      {/* Config grid */}
      <ConfigSection
        fieldValue={fieldValue}
        setDraftField={setDraftField}
        commitField={commitField}
        onToggleUrlRelay={checked => {
          setDraftField('allow_url_relay', checked);
          pushConfig({ allow_url_relay: checked });
          setDraft(prev => {
            const next = { ...prev };
            delete next.allow_url_relay;
            return next;
          });
        }}
      />

      {/* Per-bot vision toggles */}
      <PerBotSection
        visionEligibleBots={visionEligibleBots}
        onToggle={togglePerBotVision}
      />

      {/* Logs modal */}
      {logsOpen && (
        <LogsModal
          logs={logs}
          onRefresh={fetchLogs}
          onClose={() => setLogsOpen(false)}
        />
      )}
    </div>
  );
};

export default VisionBotManagement;
