import React from 'react';
import './ChatBotManagement.css';
import { ChatBotManagementProps } from './chatBotManagement/types';
import { useChatBotManagement } from './chatBotManagement/useChatBotManagement';
import LLMStatusPanel from './chatBotManagement/LLMStatusPanel';
import ModelSelector from './chatBotManagement/ModelSelector';
import GlobalPromptSection from './chatBotManagement/GlobalPromptSection';
import MovieBotSection from './chatBotManagement/MovieBotSection';
import ChatBotList from './chatBotManagement/ChatBotList';
import BotForm from './chatBotManagement/BotForm';
import HistoryModal from './chatBotManagement/HistoryModal';
import MovieBotLogsModal from './chatBotManagement/MovieBotLogsModal';

const ChatBotManagement: React.FC<ChatBotManagementProps> = ({ addLog }) => {
  const h = useChatBotManagement(addLog);

  return (
    <div className="chatbot-management">
      {/* LLM Status */}
      <LLMStatusPanel llmStatus={h.llmStatus} />

      {/* Model Selection */}
      <ModelSelector
        currentModel={h.currentModel}
        availableModels={h.availableModels}
        switchingModel={h.switchingModel}
        switchModel={h.switchModel}
      />

      {/* Global Prompt Configuration */}
      <GlobalPromptSection
        globalPrompt={h.globalPrompt}
        showGlobalPromptEdit={h.showGlobalPromptEdit}
        editedGlobalPrompt={h.editedGlobalPrompt}
        setShowGlobalPromptEdit={h.setShowGlobalPromptEdit}
        setEditedGlobalPrompt={h.setEditedGlobalPrompt}
        saveGlobalPrompt={h.saveGlobalPrompt}
      />

      {/* MovieBot Controls */}
      <MovieBotSection
        movieBotStatus={h.movieBotStatus}
        transcriptionDuration={h.transcriptionDuration}
        setTranscriptionDuration={h.setTranscriptionDuration}
        transcriptionFrequency={h.transcriptionFrequency}
        setTranscriptionFrequency={h.setTranscriptionFrequency}
        groqEnabled={h.groqEnabled}
        setGroqEnabled={h.setGroqEnabled}
        groqApiKey={h.groqApiKey}
        setGroqApiKey={h.setGroqApiKey}
        groqModel={h.groqModel}
        setGroqModel={h.setGroqModel}
        groqModels={h.groqModels}
        updateMovieBotConfig={h.updateMovieBotConfig}
        updateGroqConfig={h.updateGroqConfig}
        enableMovieBot={h.enableMovieBot}
        disableMovieBot={h.disableMovieBot}
        openMovieBotLogsModal={h.openMovieBotLogsModal}
        addLog={addLog}
      />

      {/* Chatbot List */}
      <ChatBotList
        chatbots={h.chatbots}
        togglingAll={h.togglingAll}
        editingTimeRemaining={h.editingTimeRemaining}
        setEditingTimeRemaining={h.setEditingTimeRemaining}
        setShowCreateForm={h.setShowCreateForm}
        handleEnableAll={h.handleEnableAll}
        handleDisableAll={h.handleDisableAll}
        handleExtendTime={h.handleExtendTime}
        handleToggle={h.handleToggle}
        handleToggleMovieBot={h.handleToggleMovieBot}
        handleSendMessage={h.handleSendMessage}
        handleTest={h.handleTest}
        handleDelete={h.handleDelete}
        startEdit={h.startEdit}
        fetchBotHistory={h.fetchBotHistory}
        formatMessageTime={h.formatMessageTime}
      />

      {/* Create/Edit Form */}
      {(h.showCreateForm || h.editingBot) && (
        <BotForm
          editingBot={h.editingBot}
          formData={h.formData}
          setFormData={h.setFormData}
          currentModel={h.currentModel}
          promptTemplates={h.promptTemplates}
          handleCreate={h.handleCreate}
          handleUpdate={h.handleUpdate}
          setShowCreateForm={h.setShowCreateForm}
          setEditingBot={h.setEditingBot}
          resetForm={h.resetForm}
        />
      )}

      {/* Message History Modal */}
      {h.selectedBotHistory && (
        <HistoryModal
          selectedBotHistory={h.selectedBotHistory}
          setSelectedBotHistory={h.setSelectedBotHistory}
        />
      )}

      {/* MovieBot Logs Modal */}
      {h.movieBotLogsModal && (
        <MovieBotLogsModal
          movieBotLogs={h.movieBotLogs}
          closeMovieBotLogsModal={h.closeMovieBotLogsModal}
        />
      )}
    </div>
  );
};

export default ChatBotManagement;
