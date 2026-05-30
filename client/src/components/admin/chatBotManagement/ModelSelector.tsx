import React from 'react';

interface ModelSelectorProps {
  currentModel: any;
  availableModels: any[];
  switchingModel: boolean;
  switchModel: (modelName: string) => void;
}

const ModelSelector: React.FC<ModelSelectorProps> = ({
  currentModel,
  availableModels,
  switchingModel,
  switchModel,
}) => {
  return (
    <div className="model-selector">
      <h3>LLM Model Selection</h3>
      <div className="model-dropdown-section">
        <label htmlFor="model-select">
          Current Model: <strong>{currentModel?.info.displayName || 'Loading...'}</strong>
          {currentModel && <span className="model-size">({currentModel.info.size})</span>}
        </label>
        <select
          id="model-select"
          value={currentModel?.name || ''}
          onChange={(e) => switchModel(e.target.value)}
          disabled={switchingModel}
          className="model-dropdown"
        >
          {availableModels.map(model => (
            <option key={model.name} value={model.name}>
              {model.displayName} - {model.size}
            </option>
          ))}
        </select>
        {switchingModel && <div className="switching-indicator">Switching model...</div>}
      </div>
    </div>
  );
};

export default ModelSelector;
