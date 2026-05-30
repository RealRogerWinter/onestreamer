import React from 'react';
import {
  Link2,
  Square,
  RefreshCw,
  CheckCircle,
  AlertCircle,
  Activity,
  Star,
  Shuffle,
} from 'lucide-react';
import './URLStreamManagement.css';
import { URLStreamManagementProps } from './urlStreamManagement/types';
import { useURLStreamData } from './urlStreamManagement/useURLStreamData';
import NewStreamForm from './urlStreamManagement/NewStreamForm';
import StreamsView from './urlStreamManagement/StreamsView';
import PresetsView from './urlStreamManagement/PresetsView';
import RandomRotationView from './urlStreamManagement/RandomRotationView';

const URLStreamManagement: React.FC<URLStreamManagementProps> = ({ makeApiCall, addLog }) => {
  const {
    streams,
    presets,
    toolsStatus,
    loading,
    isStarting,
    activeTab,
    setActiveTab,
    randomStatus,
    isRandomLoading,
    showRandomSettings,
    setShowRandomSettings,
    randomSettings,
    setRandomSettings,
    newUrl,
    setNewUrl,
    selectedQuality,
    setSelectedQuality,
    displayName,
    setDisplayName,
    autoReconnect,
    setAutoReconnect,
    validating,
    validationResult,
    showPresetForm,
    setShowPresetForm,
    presetName,
    setPresetName,
    fetchData,
    handleValidate,
    handleStartStream,
    handleStopStream,
    handleStopAll,
    handleSavePreset,
    handleStartPreset,
    handleDeletePreset,
    handleStartRandomRotation,
    handleStopRandomRotation,
    handleSkipToNext,
    handleSaveRandomSettings,
  } = useURLStreamData(makeApiCall, addLog);

  if (loading) {
    return (
      <div className="url-stream-management">
        <div className="loading-state">
          <RefreshCw className="spin" />
          <p>Loading URL Stream Manager...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="url-stream-management">
      {/* Header */}
      <div className="manager-header">
        <div className="header-title">
          <Link2 size={24} />
          <h2>URL Stream Relay</h2>
          <span className="header-subtitle">Stream from Twitch, YouTube, Kick & more</span>
        </div>

        <div className="header-actions">
          {streams.length > 0 && (
            <button className="stop-all-btn" onClick={handleStopAll}>
              <Square size={16} />
              Stop All
            </button>
          )}
          <button className="refresh-btn" onClick={fetchData}>
            <RefreshCw size={16} />
          </button>
        </div>
      </div>

      {/* Tools Status */}
      <div className="tools-status">
        <div className={`tool-badge ${toolsStatus?.streamlink ? 'available' : 'unavailable'}`}>
          {toolsStatus?.streamlink ? <CheckCircle size={14} /> : <AlertCircle size={14} />}
          streamlink
        </div>
        <div className={`tool-badge ${toolsStatus?.ytdlp ? 'available' : 'unavailable'}`}>
          {toolsStatus?.ytdlp ? <CheckCircle size={14} /> : <AlertCircle size={14} />}
          yt-dlp
        </div>
      </div>

      {/* New Stream Form */}
      <NewStreamForm
        newUrl={newUrl}
        setNewUrl={setNewUrl}
        selectedQuality={selectedQuality}
        setSelectedQuality={setSelectedQuality}
        displayName={displayName}
        setDisplayName={setDisplayName}
        autoReconnect={autoReconnect}
        setAutoReconnect={setAutoReconnect}
        validating={validating}
        validationResult={validationResult}
        isStarting={isStarting}
        showPresetForm={showPresetForm}
        setShowPresetForm={setShowPresetForm}
        presetName={presetName}
        setPresetName={setPresetName}
        handleValidate={handleValidate}
        handleStartStream={handleStartStream}
        handleSavePreset={handleSavePreset}
      />

      {/* Tabs */}
      <div className="tabs">
        <button
          className={`tab ${activeTab === 'streams' ? 'active' : ''}`}
          onClick={() => setActiveTab('streams')}
        >
          <Activity size={16} />
          Active Streams ({streams.length})
        </button>
        <button
          className={`tab ${activeTab === 'presets' ? 'active' : ''}`}
          onClick={() => setActiveTab('presets')}
        >
          <Star size={16} />
          Presets ({presets.length})
        </button>
        <button
          className={`tab ${activeTab === 'random' ? 'active' : ''}`}
          onClick={() => setActiveTab('random')}
        >
          <Shuffle size={16} />
          Random Rotation
          {randomStatus?.enabled && <span className="tab-badge live">LIVE</span>}
        </button>
      </div>

      {/* Active Streams */}
      {activeTab === 'streams' && (
        <StreamsView streams={streams} handleStopStream={handleStopStream} />
      )}

      {/* Presets */}
      {activeTab === 'presets' && (
        <PresetsView
          presets={presets}
          handleStartPreset={handleStartPreset}
          handleDeletePreset={handleDeletePreset}
        />
      )}

      {/* Random Rotation */}
      {activeTab === 'random' && (
        <RandomRotationView
          randomStatus={randomStatus}
          randomSettings={randomSettings}
          setRandomSettings={setRandomSettings}
          isRandomLoading={isRandomLoading}
          showRandomSettings={showRandomSettings}
          setShowRandomSettings={setShowRandomSettings}
          handleStartRandomRotation={handleStartRandomRotation}
          handleStopRandomRotation={handleStopRandomRotation}
          handleSkipToNext={handleSkipToNext}
          handleSaveRandomSettings={handleSaveRandomSettings}
        />
      )}
    </div>
  );
};

export default URLStreamManagement;
