import React, { useState, useEffect, useRef } from 'react';
import authService from '../../../services/AuthService';
import {
  ChatBot,
  MovieBotStatus,
  ChatBotFormData,
  PromptTemplate,
} from './types';

/**
 * useChatBotManagement
 *
 * Owns all data + interaction logic for the ChatBotManagement admin panel.
 * Extracted verbatim from the original component so the view layer can stay a
 * thin set of presentational pieces. Data is loaded via the global fetch() API
 * with an `Authorization: Bearer <authService.getToken()>` header (plus an
 * `x-admin-key` from localStorage for the MovieBot/Groq admin endpoints).
 */
export function useChatBotManagement(addLog: (message: string) => void) {
  const [chatbots, setChatbots] = useState<ChatBot[]>([]);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [editingBot, setEditingBot] = useState<ChatBot | null>(null);
  const [llmStatus, setLlmStatus] = useState<{ available: boolean; model: string; host: string } | null>(null);
  const [selectedBotHistory, setSelectedBotHistory] = useState<{ botId: number; messages: any[] } | null>(null);
  const [globalPrompt, setGlobalPrompt] = useState<string>('');
  const [showGlobalPromptEdit, setShowGlobalPromptEdit] = useState(false);
  const [editedGlobalPrompt, setEditedGlobalPrompt] = useState<string>('');
  const [availableModels, setAvailableModels] = useState<any[]>([]);
  const [currentModel, setCurrentModel] = useState<any>(null);
  const [switchingModel, setSwitchingModel] = useState(false);
  const [togglingAll, setTogglingAll] = useState(false);
  const [editingTimeRemaining, setEditingTimeRemaining] = useState<{[key: number]: string}>({});

  // MovieBot state
  const [movieBotStatus, setMovieBotStatus] = useState<MovieBotStatus | null>(null);
  const [movieBotLogs, setMovieBotLogs] = useState<any[]>([]);
  const [movieBotLogsModal, setMovieBotLogsModal] = useState(false);
  const [groqEnabled, setGroqEnabled] = useState(false);
  const [groqApiKey, setGroqApiKey] = useState(localStorage.getItem('groqApiKey') || '');
  const [groqModel, setGroqModel] = useState('llama-3.1-8b-instant');
  const [groqModels, setGroqModels] = useState<any[]>([]);
  const [transcriptionDuration, setTranscriptionDuration] = useState(45);
  const [transcriptionFrequency, setTranscriptionFrequency] = useState(120);

  // Track if initial values have been set from movieBotStatus
  const initialValuesSet = useRef(false);

  const [formData, setFormData] = useState<ChatBotFormData>({
    name: '',
    prompt: 'You are a friendly and engaging chat participant who loves the stream.',
    response_interval_min: 60,
    response_interval_max: 180,
    show_robot_emoji: true,
    use_assigned_name: true,
    llm_model: null,
    moviebot_enabled: false,
    personality_traits: {
      enthusiasm: false,
      casual: true,
      supportive: false,
      humorous: false,
      curious: false,
      temperature: 0.7
    }
  });

  const serverUrl = process.env.REACT_APP_SERVER_URL || '';

  useEffect(() => {
    fetchChatbots();
    checkLLMStatus();
    fetchGlobalPrompt();
    fetchAvailableModels();
    fetchMovieBotStatus();
    fetchGroqStatus(); // Fetch global Groq status
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Initialize Groq setting
  useEffect(() => {
    const storedGroqEnabled = localStorage.getItem('groqEnabled');
    if (storedGroqEnabled !== null) {
      setGroqEnabled(storedGroqEnabled === 'true');
    } else if (movieBotStatus?.config?.useGroq !== undefined) {
      setGroqEnabled(movieBotStatus.config.useGroq);
    }
  }, [movieBotStatus?.config?.useGroq]);

  // Auto-refresh temporary bots to update time remaining
  useEffect(() => {
    const hasTemporaryBots = chatbots.some(bot => bot.is_temporary);

    if (hasTemporaryBots) {
      const interval = setInterval(() => {
        fetchChatbots();
      }, 30000); // Refresh every 30 seconds

      return () => clearInterval(interval);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatbots]);

  // Set initial transcription values only once when movieBotStatus first loads
  useEffect(() => {
    if (movieBotStatus?.config && !initialValuesSet.current) {
      setTranscriptionDuration(movieBotStatus.config.transcriptionDuration || 45);
      setTranscriptionFrequency(movieBotStatus.config.transcriptionFrequency || 120);
      initialValuesSet.current = true;
    }
  }, [movieBotStatus?.config]);

  const fetchChatbots = async () => {
    try {
      const response = await fetch(`${serverUrl}/api/chatbots`, {
        headers: {
          'Authorization': `Bearer ${authService.getToken()}`
        }
      });

      if (!response.ok) throw new Error('Failed to fetch chatbots');

      const data = await response.json();
      console.log('🤖 Fetched chatbots data:', data);
      // Ensure personality_traits is properly typed
      const formattedData = data.map((bot: any) => ({
        ...bot,
        personality_traits: bot.personality_traits || undefined
      }));
      setChatbots(formattedData);
      addLog(`Loaded ${data.length} chatbots`);
    } catch (error) {
      addLog(`Error fetching chatbots: ${error}`);
    }
  };

  const fetchGlobalPrompt = async () => {
    try {
      const response = await fetch(`${serverUrl}/api/chatbots/config`, {
        headers: {
          'Authorization': `Bearer ${authService.getToken()}`
        }
      });

      if (!response.ok) throw new Error('Failed to fetch global prompt');

      const config = await response.json();
      setGlobalPrompt(config.global_prompt || '');
      setEditedGlobalPrompt(config.global_prompt || '');
    } catch (error) {
      console.error('Error fetching global prompt:', error);
    }
  };

  const saveGlobalPrompt = async () => {
    try {
      const response = await fetch(`${serverUrl}/api/chatbots/config`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authService.getToken()}`
        },
        body: JSON.stringify({ global_prompt: editedGlobalPrompt })
      });

      if (!response.ok) throw new Error('Failed to save global prompt');

      const config = await response.json();
      setGlobalPrompt(config.global_prompt);
      setShowGlobalPromptEdit(false);
      addLog('Global prompt updated successfully');
    } catch (error) {
      addLog(`Error saving global prompt: ${error}`);
    }
  };

  const fetchAvailableModels = async () => {
    try {
      const response = await fetch(`${serverUrl}/api/chatbots/models`, {
        headers: {
          'Authorization': `Bearer ${authService.getToken()}`
        }
      });

      if (!response.ok) throw new Error('Failed to fetch available models');

      const data = await response.json();
      setAvailableModels(data.available);
      setCurrentModel(data.current);
    } catch (error) {
      console.error('Error fetching available models:', error);
    }
  };

  const fetchMovieBotStatus = async () => {
    try {
      const adminKey = localStorage.getItem('adminKey') || '';
      // console.log('Using admin key:', adminKey);
      const response = await fetch(`${serverUrl}/admin/moviebot/status`, {
        headers: {
          'Authorization': `Bearer ${authService.getToken()}`,
          'x-admin-key': adminKey
        }
      });

      if (response.ok) {
        const data = await response.json();
        // console.log('MovieBot status fetched:', data);
        setMovieBotStatus(data);
      } else {
        console.error('MovieBot status fetch failed:', response.status, await response.text());
      }
    } catch (error) {
      console.error('Error fetching MovieBot status:', error);
    }
  };

  const enableMovieBot = async () => {
    try {
      const adminKey = localStorage.getItem('adminKey') || '';
      const response = await fetch(`${serverUrl}/admin/moviebot/enable`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authService.getToken()}`,
          'x-admin-key': adminKey
        },
        body: JSON.stringify({})
      });

      if (response.ok) {
        addLog('MovieBot enabled successfully');
        fetchMovieBotStatus();
      } else {
        const error = await response.json();
        addLog(`Failed to enable MovieBot: ${error.error}`);
      }
    } catch (error) {
      console.error('Error enabling MovieBot:', error);
      addLog('Failed to enable MovieBot');
    }
  };

  const disableMovieBot = async () => {
    try {
      const adminKey = localStorage.getItem('adminKey') || '';
      const response = await fetch(`${serverUrl}/admin/moviebot/disable`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${authService.getToken()}`,
          'x-admin-key': adminKey
        }
      });

      if (response.ok) {
        addLog('MovieBot disabled successfully');
        fetchMovieBotStatus();
      } else {
        const error = await response.json();
        addLog(`Failed to disable MovieBot: ${error.error}`);
      }
    } catch (error) {
      console.error('Error disabling MovieBot:', error);
      addLog('Failed to disable MovieBot');
    }
  };

  // Global Groq API functions
  const fetchGroqStatus = async () => {
    try {
      const adminKey = localStorage.getItem('adminKey') || '';
      const response = await fetch(`${serverUrl}/admin/groq/status`, {
        headers: {
          'Authorization': `Bearer ${authService.getToken()}`,
          'x-admin-key': adminKey
        }
      });

      if (response.ok) {
        const status = await response.json();
        setGroqEnabled(status.enabled);
        setGroqModel(status.model || 'llama-3.1-8b-instant');
        if (status.availableModels) {
          setGroqModels(status.availableModels);
        }
        if (status.hasApiKey) {
          // Don't overwrite local API key if server has one
          // console.log('Server has Groq API key configured');
        }
        // console.log('Global Groq status:', status);
      }
    } catch (error) {
      console.error('Error fetching Groq status:', error);
    }
  };

  const updateGroqConfig = async (enabled: boolean, apiKey?: string, model?: string) => {
    try {
      const adminKey = localStorage.getItem('adminKey') || '';
      const body: any = { enabled };

      if (apiKey !== undefined) {
        body.apiKey = apiKey;
      }

      if (model !== undefined) {
        body.model = model;
      }

      const response = await fetch(`${serverUrl}/admin/groq/config`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authService.getToken()}`,
          'x-admin-key': adminKey
        },
        body: JSON.stringify(body)
      });

      if (response.ok) {
        await response.json();
        if (model) {
          addLog(`Groq model changed to: ${model}`);
        } else {
          addLog(`Global Groq ${enabled ? 'enabled' : 'disabled'} for ALL chatbots`);
        }
        // console.log('Global Groq config updated:', result);

        // Also update MovieBot config to match
        if (movieBotStatus?.config) {
          updateMovieBotConfig('useGroq', enabled);
        }
      } else {
        const error = await response.json();
        addLog(`Failed to update Groq config: ${error.error}`);
      }
    } catch (error) {
      console.error('Error updating Groq config:', error);
      addLog('Failed to update Groq configuration');
    }
  };

  const updateMovieBotConfig = async (key: string, value: number | boolean | string) => {
    try {
      const adminKey = localStorage.getItem('adminKey') || '';

      // Add debugging
      // console.log('Updating MovieBot config:', { key, value });
      // console.log('Current movieBotStatus:', movieBotStatus);

      // Use existing config or default values
      const currentConfig = movieBotStatus?.config || {
        transcriptionDuration: 45,
        transcriptionFrequency: 120,
        chatHistoryLimit: 30,
        useGroq: false,
        messageDelay: {
          min: 4000,
          max: 8000
        }
      };

      const updatedConfig = {
        ...currentConfig,
        [key]: value
      };

      // console.log('Sending config update:', updatedConfig);

      const response = await fetch(`${serverUrl}/admin/moviebot/config`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authService.getToken()}`,
          'x-admin-key': adminKey
        },
        body: JSON.stringify(updatedConfig)
      });

      // console.log('Response status:', response.status);

      if (response.ok) {
        await response.json();
        // console.log('Config update result:', result);
        addLog(`MovieBot config updated: ${key} = ${value}`);

        // Don't update movieBotStatus here as it might interfere with local state
        // The server has the updated config now

        // Don't fetch status again - it will reset our local state!
      } else {
        const errorText = await response.text();
        console.error('Error response:', errorText);
        try {
          const error = JSON.parse(errorText);
          addLog(`Failed to update MovieBot config: ${error.error}`);
        } catch {
          addLog(`Failed to update MovieBot config: ${errorText}`);
        }
      }
    } catch (error) {
      console.error('Error updating MovieBot config:', error);
      addLog(`Error updating MovieBot config: ${error}`);
    }
  };

  const fetchMovieBotLogs = async () => {
    try {
      const adminKey = localStorage.getItem('adminKey') || '';
      const response = await fetch(`${serverUrl}/admin/moviebot/logs?limit=50`, {
        headers: {
          'Authorization': `Bearer ${authService.getToken()}`,
          'x-admin-key': adminKey
        }
      });

      if (response.ok) {
        const data = await response.json();
        setMovieBotLogs(data.logs || []);
      }
    } catch (error) {
      console.error('Error fetching MovieBot logs:', error);
    }
  };

  const openMovieBotLogsModal = async () => {
    setMovieBotLogsModal(true);
    await fetchMovieBotLogs();
  };

  const closeMovieBotLogsModal = () => {
    setMovieBotLogsModal(false);
  };

  // Set up real-time updates for MovieBot logs
  React.useEffect(() => {
    let interval: NodeJS.Timeout;

    if (movieBotLogsModal) {
      // Initial fetch
      fetchMovieBotLogs();

      // Set up polling every 3 seconds
      interval = setInterval(() => {
        fetchMovieBotLogs();
      }, 3000);
    }

    return () => {
      if (interval) {
        clearInterval(interval);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movieBotLogsModal]);

  const switchModel = async (modelName: string) => {
    setSwitchingModel(true);
    try {
      const response = await fetch(`${serverUrl}/api/chatbots/models`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authService.getToken()}`
        },
        body: JSON.stringify({ model: modelName })
      });

      if (!response.ok) throw new Error('Failed to switch model');

      const result = await response.json();

      // Update current model info
      await fetchAvailableModels();
      await checkLLMStatus();

      addLog(`🤖 Switched to model: ${modelName} (Available: ${result.available ? 'Yes' : 'No'})`);
    } catch (error) {
      addLog(`Error switching model: ${error}`);
    } finally {
      setSwitchingModel(false);
    }
  };

  const checkLLMStatus = async () => {
    try {
      const response = await fetch(`${serverUrl}/api/chatbots/llm-status`, {
        headers: {
          'Authorization': `Bearer ${authService.getToken()}`
        }
      });

      if (!response.ok) throw new Error('Failed to check LLM status');

      const status = await response.json();
      setLlmStatus(status);
      addLog(`LLM Status: ${status.available ? 'Available' : 'Not Available'} (${status.model})`);
    } catch (error) {
      addLog(`Error checking LLM status: ${error}`);
    }
  };

  const fetchBotHistory = async (botId: number) => {
    try {
      const response = await fetch(`${serverUrl}/api/chatbots/${botId}/history`, {
        headers: {
          'Authorization': `Bearer ${authService.getToken()}`
        }
      });

      if (!response.ok) throw new Error('Failed to fetch history');

      const messages = await response.json();
      setSelectedBotHistory({ botId, messages });
    } catch (error) {
      addLog(`Error fetching bot history: ${error}`);
    }
  };

  const handleCreate = async () => {
    try {
      const response = await fetch(`${serverUrl}/api/chatbots`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authService.getToken()}`
        },
        body: JSON.stringify(formData)
      });

      if (!response.ok) throw new Error('Failed to create chatbot');

      const newBot = await response.json();
      addLog(`Created chatbot: ${newBot.name}`);
      fetchChatbots();
      setShowCreateForm(false);
      resetForm();
    } catch (error) {
      addLog(`Error creating chatbot: ${error}`);
    }
  };

  const handleUpdate = async () => {
    if (!editingBot) return;

    try {
      const response = await fetch(`${serverUrl}/api/chatbots/${editingBot.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authService.getToken()}`
        },
        body: JSON.stringify(formData)
      });

      if (!response.ok) throw new Error('Failed to update chatbot');

      addLog(`Updated chatbot: ${formData.name}`);
      fetchChatbots();
      setEditingBot(null);
      resetForm();
    } catch (error) {
      addLog(`Error updating chatbot: ${error}`);
    }
  };

  const handleExtendTime = async (botId: number, additionalMinutes: number) => {
    if (isNaN(additionalMinutes) || additionalMinutes <= 0) {
      addLog('Please enter a valid number of minutes');
      return;
    }

    try {
      const response = await fetch(`${serverUrl}/api/chatbots/${botId}/extend-time`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authService.getToken()}`
        },
        body: JSON.stringify({ additionalMinutes })
      });

      if (!response.ok) throw new Error('Failed to extend bot time');

      const result = await response.json();
      addLog(`Extended bot time by ${additionalMinutes} minutes. New expiration: ${result.expires_at}`);

      // Clear the editing state for this bot
      const newEditing = {...editingTimeRemaining};
      delete newEditing[botId];
      setEditingTimeRemaining(newEditing);

      // Refresh the bot list
      fetchChatbots();
    } catch (error) {
      addLog(`Error extending bot time: ${error}`);
    }
  };

  const handleDelete = async (id: number) => {
    if (!window.confirm('Are you sure you want to delete this chatbot?')) return;

    try {
      const response = await fetch(`${serverUrl}/api/chatbots/${id}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${authService.getToken()}`
        }
      });

      if (!response.ok) throw new Error('Failed to delete chatbot');

      addLog(`Deleted chatbot`);
      fetchChatbots();
    } catch (error) {
      addLog(`Error deleting chatbot: ${error}`);
    }
  };

  const handleToggle = async (id: number) => {
    try {
      const response = await fetch(`${serverUrl}/api/chatbots/${id}/toggle`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${authService.getToken()}`
        }
      });

      if (!response.ok) throw new Error('Failed to toggle chatbot');

      const bot = await response.json();
      addLog(`Toggled chatbot ${bot.name}: ${bot.is_enabled ? 'ON' : 'OFF'}`);
      fetchChatbots();
    } catch (error) {
      addLog(`Error toggling chatbot: ${error}`);
    }
  };

  const handleToggleMovieBot = async (id: number) => {
    try {
      const bot = chatbots.find(b => b.id === id);
      if (!bot) return;

      const response = await fetch(`${serverUrl}/api/chatbots/${id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authService.getToken()}`
        },
        body: JSON.stringify({ moviebot_enabled: !bot.moviebot_enabled })
      });

      if (!response.ok) throw new Error('Failed to toggle MovieBot');

      const updatedBot = await response.json();
      addLog(`${updatedBot.name}: MovieBot ${updatedBot.moviebot_enabled ? 'ENABLED' : 'DISABLED'}`);
      fetchChatbots();
    } catch (error) {
      addLog(`Error toggling MovieBot: ${error}`);
    }
  };

  const handleTest = async (id: number) => {
    try {
      const response = await fetch(`${serverUrl}/api/chatbots/${id}/test`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${authService.getToken()}`
        }
      });

      if (!response.ok) throw new Error('Failed to test chatbot');

      const result = await response.json();
      addLog(`Test response from ${result.bot_name}: "${result.response}"`);
      alert(`Test Response:\n\n"${result.response}"\n\nContext:\n${result.context.map((c: any) => `${c.username}: ${c.message}`).join('\n')}`);

      // Note: Test doesn't update last_message since it's not sent to chat
    } catch (error) {
      addLog(`Error testing chatbot: ${error}`);
    }
  };

  const handleSendMessage = async (id: number, customMessage?: string) => {
    try {
      // Always auto-generate unless a specific custom message is provided
      const response = await fetch(`${serverUrl}/api/chatbots/${id}/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authService.getToken()}`
        },
        body: JSON.stringify({ message: customMessage || null })
      });

      if (!response.ok) throw new Error('Failed to send message');

      const result = await response.json();
      addLog(`📤 Auto-generated message from ${result.bot_name}: "${result.message}"`);

      // Refresh the bot list to show the new last message
      setTimeout(() => fetchChatbots(), 1000);
    } catch (error) {
      addLog(`Error sending message: ${error}`);
    }
  };

  const handleEnableAll = async () => {
    setTogglingAll(true);
    try {
      const response = await fetch(`${serverUrl}/api/chatbots/all/enable`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${authService.getToken()}`
        }
      });

      if (!response.ok) throw new Error('Failed to enable all chatbots');

      const result = await response.json();
      addLog(`✅ Enabled all ${result.count} chatbots`);
      fetchChatbots();
    } catch (error) {
      addLog(`Error enabling all chatbots: ${error}`);
    } finally {
      setTogglingAll(false);
    }
  };

  const handleDisableAll = async () => {
    // console.log('🔴 DISABLE ALL: Button clicked');
    // console.log('🔴 DISABLE ALL: Server URL:', serverUrl);
    // console.log('🔴 DISABLE ALL: Auth token:', authService.getToken() ? 'Present' : 'Missing');

    setTogglingAll(true);
    try {
      // console.log('🔴 DISABLE ALL: Making API request...');
      const response = await fetch(`${serverUrl}/api/chatbots/all/disable`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${authService.getToken()}`
        }
      });

      // console.log('🔴 DISABLE ALL: Response status:', response.status);
      // console.log('🔴 DISABLE ALL: Response ok:', response.ok);

      if (!response.ok) {
        const errorText = await response.text();
        // console.log('🔴 DISABLE ALL: Error response text:', errorText);
        throw new Error(`Failed to disable all chatbots: ${response.status} - ${errorText}`);
      }

      const result = await response.json();
      // console.log('🔴 DISABLE ALL: Success response:', result);
      addLog(`✅ Disabled all ${result.count} chatbots`);
      fetchChatbots();
    } catch (error) {
      console.error('🔴 DISABLE ALL: Error:', error);
      addLog(`Error disabling all chatbots: ${error}`);
    } finally {
      setTogglingAll(false);
    }
  };

  const startEdit = (bot: ChatBot) => {
    setEditingBot(bot);
    setFormData({
      name: bot.name,
      prompt: bot.prompt,
      response_interval_min: bot.response_interval_min,
      response_interval_max: bot.response_interval_max,
      show_robot_emoji: bot.show_robot_emoji,
      use_assigned_name: bot.use_assigned_name !== undefined ? bot.use_assigned_name : true,
      llm_model: bot.llm_model || null,
      moviebot_enabled: bot.moviebot_enabled !== undefined ? bot.moviebot_enabled : false,
      personality_traits: bot.personality_traits || {
        enthusiasm: false,
        casual: true,
        supportive: false,
        humorous: false,
        curious: false,
        temperature: 0.7
      }
    });
  };

  const resetForm = () => {
    setFormData({
      name: '',
      prompt: 'You are a friendly and engaging chat participant who loves the stream.',
      response_interval_min: 60,
      response_interval_max: 180,
      show_robot_emoji: true,
      use_assigned_name: true,
      llm_model: null,
      moviebot_enabled: false,
      personality_traits: {
        enthusiasm: false,
        casual: true,
        supportive: false,
        humorous: false,
        curious: false,
        temperature: 0.7
      }
    });
  };

  const formatMessageTime = (timestamp: string) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return date.toLocaleDateString();
  };

  const promptTemplates: PromptTemplate[] = [
    { label: 'Friendly Viewer', prompt: 'You are a friendly and enthusiastic viewer who loves watching streams and chatting with others.' },
    { label: 'Gaming Expert', prompt: 'You are a knowledgeable gamer who loves discussing game strategies and sharing tips.' },
    { label: 'Hype Person', prompt: 'You are super enthusiastic and love hyping up the stream! You use lots of exclamation marks and emotes!' },
    { label: 'Chill Lurker', prompt: 'You are a relaxed viewer who occasionally chimes in with supportive comments. You keep things casual and friendly.' },
    { label: 'Question Asker', prompt: 'You are curious about everything and love asking questions about the stream and what others think.' },
    { label: 'Meme Lord', prompt: 'You love making jokes and references to memes. You keep things light and funny.' }
  ];

  return {
    // state
    chatbots,
    showCreateForm,
    setShowCreateForm,
    editingBot,
    setEditingBot,
    llmStatus,
    selectedBotHistory,
    setSelectedBotHistory,
    globalPrompt,
    showGlobalPromptEdit,
    setShowGlobalPromptEdit,
    editedGlobalPrompt,
    setEditedGlobalPrompt,
    availableModels,
    currentModel,
    switchingModel,
    togglingAll,
    editingTimeRemaining,
    setEditingTimeRemaining,
    movieBotStatus,
    movieBotLogs,
    movieBotLogsModal,
    groqEnabled,
    setGroqEnabled,
    groqApiKey,
    setGroqApiKey,
    groqModel,
    setGroqModel,
    groqModels,
    transcriptionDuration,
    setTranscriptionDuration,
    transcriptionFrequency,
    setTranscriptionFrequency,
    formData,
    setFormData,
    promptTemplates,
    // actions
    saveGlobalPrompt,
    enableMovieBot,
    disableMovieBot,
    updateGroqConfig,
    updateMovieBotConfig,
    openMovieBotLogsModal,
    closeMovieBotLogsModal,
    switchModel,
    fetchBotHistory,
    handleCreate,
    handleUpdate,
    handleExtendTime,
    handleDelete,
    handleToggle,
    handleToggleMovieBot,
    handleTest,
    handleSendMessage,
    handleEnableAll,
    handleDisableAll,
    startEdit,
    resetForm,
    formatMessageTime,
  };
}
