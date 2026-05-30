import React from 'react';
import { ChatBotRow } from './types';

interface PerBotSectionProps {
  visionEligibleBots: ChatBotRow[];
  onToggle: (botId: number, next: boolean) => void;
}

const PerBotSection: React.FC<PerBotSectionProps> = ({
  visionEligibleBots,
  onToggle,
}) => (
  <div className="vb-section">
    <h3>Per-bot opt-in</h3>
    <p className="vb-help">
      Only bots flagged here will be considered when the service dispatches a
      vision cycle. The service still also requires the global toggle above.
    </p>
    {visionEligibleBots.length === 0 ? (
      <div className="vb-empty">No enabled chatbots found.</div>
    ) : (
      <div className="vb-bot-list">
        {visionEligibleBots.map(bot => {
          const on = bot.vision_bot_enabled === true || bot.vision_bot_enabled === 1;
          return (
            <div key={bot.id} className={`vb-bot-row ${on ? 'on' : ''}`}>
              <span className="vb-bot-name">
                🤖 {bot.name}
                {bot.is_connected && <span className="vb-bot-online">● online</span>}
              </span>
              <label className="vb-switch">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={e => onToggle(bot.id, e.target.checked)}
                />
                <span className="vb-switch-slider" />
              </label>
            </div>
          );
        })}
      </div>
    )}
  </div>
);

export default PerBotSection;
