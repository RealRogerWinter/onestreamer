import React, { useState, useEffect, useRef } from 'react';
import authService from '../services/AuthService';
import './ChatBotManagement.css';

interface PersonalityTraits {
  enthusiasm: boolean;
  casual: boolean;
  supportive: boolean;
  humorous: boolean;
  curious: boolean;
  temperature: number;
}

interface ChatBot {
  id: number;
  name: string;
  prompt: string;
  is_enabled: boolean;
  response_interval_min: number;
  response_interval_max: number;
  show_robot_emoji: boolean;
  use_assigned_name: boolean;
  llm_model?: string | null;
  personality_traits?: PersonalityTraits;
  is_connected?: boolean;
  moviebot_enabled?: boolean;
  last_message?: string;
  last_message_at?: string;
  created_at: string;
  updated_at: string;
  // Temporary bot fields
  is_temporary?: boolean;
  summoned_by?: string;
  summoned_by_user_id?: number;
  personality_prompt?: string;
  expires_at?: string;
  time_remaining_seconds?: number;
  time_remaining_display?: string;
}

interface ChatBotManagementProps {
  addLog: (message: string) => void;
}

interface MovieBotStatus {
  enabled: boolean;
  isActive: boolean;
  currentStreamerId: string | null;
  config: {
    transcriptionDuration: number;
    minInterval: number;
    maxInterval: number;
    chatHistoryLimit: number;
    transcriptionsPerCycle?: number;
    timeBetweenTranscriptions?: number;
    transcriptionFrequency?: number;
    useGroq?: boolean;
  };
  recentPrompts: any[];
}

const ChatBotManagement: React.FC<ChatBotManagementProps> = ({ addLog }) => {
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
  
  const [formData, setFormData] = useState<{
    name: string;
    prompt: string;
    response_interval_min: number;
    response_interval_max: number;
    show_robot_emoji: boolean;
    use_assigned_name: boolean;
    llm_model: string | null;
    moviebot_enabled: boolean;
    personality_traits: PersonalityTraits;
  }>({
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
      const adminKey = localStorage.getItem('adminKey') || '***REMOVED-ADMIN-KEY***';
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
      const adminKey = localStorage.getItem('adminKey') || '***REMOVED-ADMIN-KEY***';
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
      const adminKey = localStorage.getItem('adminKey') || '***REMOVED-ADMIN-KEY***';
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
      const adminKey = localStorage.getItem('adminKey') || '***REMOVED-ADMIN-KEY***';
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
      const adminKey = localStorage.getItem('adminKey') || '***REMOVED-ADMIN-KEY***';
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
        const result = await response.json();
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
      const adminKey = localStorage.getItem('adminKey') || '***REMOVED-ADMIN-KEY***';
      
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
        const result = await response.json();
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
      const adminKey = localStorage.getItem('adminKey') || '***REMOVED-ADMIN-KEY***';
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
  
  const promptTemplates = [
    { label: 'Friendly Viewer', prompt: 'You are a friendly and enthusiastic viewer who loves watching streams and chatting with others.' },
    { label: 'Gaming Expert', prompt: 'You are a knowledgeable gamer who loves discussing game strategies and sharing tips.' },
    { label: 'Hype Person', prompt: 'You are super enthusiastic and love hyping up the stream! You use lots of exclamation marks and emotes!' },
    { label: 'Chill Lurker', prompt: 'You are a relaxed viewer who occasionally chimes in with supportive comments. You keep things casual and friendly.' },
    { label: 'Question Asker', prompt: 'You are curious about everything and love asking questions about the stream and what others think.' },
    { label: 'Meme Lord', prompt: 'You love making jokes and references to memes. You keep things light and funny.' }
  ];

  return (
    <div className="chatbot-management">
      {/* LLM Status */}
      <div className="llm-status">
        <h3>LLM Status</h3>
        {llmStatus ? (
          <div className={`status-indicator ${llmStatus.available ? 'available' : 'unavailable'}`}>
            <span className="status-dot"></span>
            <span>{llmStatus.available ? 'Connected' : 'Not Available'}</span>
            <span className="model-info">Model: {llmStatus.model}</span>
          </div>
        ) : (
          <div>Checking...</div>
        )}
        {!llmStatus?.available && (
          <div className="llm-warning">
            ⚠️ Cannot detect Ollama from browser (CORS restriction).
            <br />
            Check server logs for: "✅ ChatBot LLM: Connected to Ollama with model mistral"
            <br />
            If not connected, run: <code>ollama serve</code> then restart the server.
          </div>
        )}
      </div>

      {/* Model Selection */}
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

      {/* Global Prompt Configuration */}
      <div className="global-prompt-section">
        <h3>Global Prompt (Applied to All Bots)</h3>
        {!showGlobalPromptEdit ? (
          <div className="global-prompt-display">
            <div className="prompt-text">{globalPrompt || 'No global prompt set'}</div>
            <button 
              className="btn btn-secondary"
              onClick={() => {
                setEditedGlobalPrompt(globalPrompt);
                setShowGlobalPromptEdit(true);
              }}
            >
              Edit Global Prompt
            </button>
          </div>
        ) : (
          <div className="global-prompt-edit">
            <textarea
              value={editedGlobalPrompt}
              onChange={(e) => setEditedGlobalPrompt(e.target.value)}
              placeholder="Enter the global prompt that will be prepended to all bot prompts..."
              rows={6}
              className="global-prompt-textarea"
            />
            <div className="edit-actions">
              <button 
                className="btn btn-primary"
                onClick={saveGlobalPrompt}
              >
                Save
              </button>
              <button 
                className="btn btn-secondary"
                onClick={() => {
                  setShowGlobalPromptEdit(false);
                  setEditedGlobalPrompt(globalPrompt);
                }}
              >
                Cancel
              </button>
            </div>
            <div className="prompt-help">
              <small>
                This prompt is added to ALL bots before their individual prompts.
                Include general instructions about behavior, formatting, and chat context.
              </small>
            </div>
          </div>
        )}
      </div>

      {/* MovieBot Controls */}
      <div className="moviebot-section">
        <h3>🎬 MovieBot - AI Film Commentary</h3>
        <div className="moviebot-controls">
          <div className="moviebot-status">
            <div className="status-item">
              <strong>Status:</strong>
              <span className={`status-badge ${movieBotStatus?.enabled ? 'active' : 'inactive'}`}>
                {movieBotStatus?.enabled ? '● Enabled' : '○ Disabled'}
              </span>
            </div>
            {movieBotStatus?.isActive && (
              <>
                <div className="status-item">
                  <strong>Current Stream:</strong> {movieBotStatus.currentStreamerId || 'None'}
                </div>
                <div className="status-item">
                  <strong>Transcription:</strong> {movieBotStatus.config.transcriptionDuration}s chunks
                </div>
                <div className="status-item">
                  <strong>Interval:</strong> {Math.floor(movieBotStatus.config.minInterval / 1000)}-{Math.floor(movieBotStatus.config.maxInterval / 1000)}s
                </div>
              </>
            )}
          </div>
          
          {/* MovieBot Timing Configuration */}
          <div className="moviebot-config">
            <h4>Timing Configuration</h4>
            <div className="config-grid">
              <div className="config-item">
                <label>Transcription Duration:</label>
                <input
                  type="number"
                  min="10"
                  max="120"
                  value={transcriptionDuration}
                  onChange={(e) => {
                    setTranscriptionDuration(parseInt(e.target.value) || 45);
                  }}
                  onBlur={(e) => {
                    const value = parseInt(e.target.value) || 45;
                    setTranscriptionDuration(value);
                    updateMovieBotConfig('transcriptionDuration', value);
                  }}
                  className="config-input"
                />
                <small>How long to record audio (seconds)</small>
              </div>
              
              <div className="config-item">
                <label>Transcription Frequency:</label>
                <input
                  type="number"
                  min="30"
                  max="600"
                  value={transcriptionFrequency}
                  onChange={(e) => {
                    setTranscriptionFrequency(parseInt(e.target.value) || 120);
                  }}
                  onBlur={(e) => {
                    const value = parseInt(e.target.value) || 120;
                    setTranscriptionFrequency(value);
                    updateMovieBotConfig('transcriptionFrequency', value);
                  }}
                  className="config-input"
                />
                <small>How often to run transcriptions (seconds)</small>
              </div>
              
              <div className="config-item" style={{ gridColumn: '1 / -1' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <input
                    type="checkbox"
                    checked={groqEnabled}
                    onChange={(e) => {
                      const newValue = e.target.checked;
                      // console.log('Global Groq checkbox clicked:', newValue);
                      setGroqEnabled(newValue);
                      localStorage.setItem('groqEnabled', String(newValue));
                      // Update global Groq settings for ALL chatbots
                      updateGroqConfig(newValue);
                    }}
                    style={{ width: 'auto' }}
                  />
                  Use Groq API for ALL Chatbots (Ultra-Fast Responses)
                </label>
                <small>Enable Groq API globally for ALL chatbots and MovieBots - ~500ms response times instead of 10-30s with local models</small>
                
                <div style={{ marginTop: '10px' }}>
                  <label>Groq API Key:</label>
                  <input
                    type="password"
                    placeholder="gsk_..."
                    value={groqApiKey}
                    onChange={(e) => {
                      const newKey = e.target.value;
                      setGroqApiKey(newKey);
                      // Store in localStorage for persistence
                      localStorage.setItem('groqApiKey', newKey);
                    }}
                    onBlur={(e) => {
                      // Send to server when user finishes typing (on blur)
                      const key = e.target.value;
                      if (key && key.startsWith('gsk_')) {
                        // console.log('Sending Groq API key globally...');
                        updateGroqConfig(groqEnabled, key, groqModel);
                      } else if (key) {
                        console.error('Invalid Groq API key format - should start with gsk_');
                        addLog('Invalid Groq API key format - should start with gsk_');
                      }
                    }}
                    className="config-input"
                    style={{ width: '100%', opacity: groqEnabled ? 1 : 0.5 }}
                    disabled={!groqEnabled}
                  />
                  <small>Get your API key from <a href="https://console.groq.com/keys" target="_blank" rel="noopener noreferrer">console.groq.com/keys</a></small>
                  
                  {/* Groq Model Selection */}
                  {groqEnabled && (
                    <div style={{ marginTop: '15px' }}>
                      <label>Groq Model:</label>
                      <select
                        value={groqModel}
                        onChange={(e) => {
                          const newModel = e.target.value;
                          setGroqModel(newModel);
                          // console.log('Groq model changed to:', newModel);
                          updateGroqConfig(true, undefined, newModel);
                        }}
                        className="config-input"
                        style={{ width: '100%' }}
                      >
                        {groqModels.map(model => (
                          <option key={model.id} value={model.id}>
                            {model.name} - {model.speed} ({model.contextWindow} tokens)
                          </option>
                        ))}
                      </select>
                      <small style={{ display: 'block', marginTop: '5px' }}>
                        {groqModels.find(m => m.id === groqModel)?.description || ''}
                      </small>
                    </div>
                  )}
                  
                  {groqEnabled && groqApiKey && (
                    <button 
                      className="btn btn-primary btn-small"
                      onClick={() => {
                        // console.log('Saving Groq API key globally...');
                        updateGroqConfig(true, groqApiKey);
                        addLog('Groq API key saved globally for ALL chatbots');
                      }}
                      style={{ marginTop: '10px', display: 'block' }}
                    >
                      Save API Key Globally
                    </button>
                  )}
                  {!groqEnabled && (
                    <small style={{ color: '#ff9800', display: 'block', marginTop: '5px' }}>
                      ⚠️ Check "Use Groq API" above to enable this field
                    </small>
                  )}
                </div>
              </div>
            </div>
          </div>
          
          <div className="moviebot-actions">
            {!movieBotStatus?.enabled ? (
              <button 
                className="btn btn-primary"
                onClick={enableMovieBot}
              >
                🎬 Enable MovieBot
              </button>
            ) : (
              <button 
                className="btn btn-danger"
                onClick={disableMovieBot}
              >
                ⏹️ Disable MovieBot
              </button>
            )}
            
            <button 
              className="btn btn-secondary"
              onClick={openMovieBotLogsModal}
            >
              📋 View Live Prompt Logs
            </button>
          </div>
          
          <div className="moviebot-description">
            <small>
              When enabled, MovieBot will periodically transcribe 10-second chunks of the stream audio
              and use them to generate contextual commentary from your chatbots about what's happening in the film.
              Bots will respond to the film content and incorporate chat reactions.
            </small>
          </div>
        </div>
      </div>

      {/* Chatbot List */}
      <div className="chatbot-list">
        <div className="list-header">
          <h3>Chatbots ({chatbots.length})</h3>
          <div className="header-controls">
            <div className="toggle-all-controls">
              <button 
                className="btn btn-secondary"
                onClick={handleEnableAll}
                disabled={togglingAll}
                title="Enable all chatbots"
              >
                {togglingAll ? 'Processing...' : '✅ Enable All'}
              </button>
              <button 
                className="btn btn-secondary"
                onClick={handleDisableAll}
                disabled={togglingAll}
                title="Disable all chatbots"
              >
                {togglingAll ? 'Processing...' : '❌ Disable All'}
              </button>
            </div>
            <button 
              className="btn btn-primary"
              onClick={() => setShowCreateForm(true)}
            >
              + Create New Bot
            </button>
          </div>
        </div>
        
        {/* User-Summoned Bots Section */}
        {chatbots.filter(bot => bot.is_temporary).length > 0 && (
          <>
            <div className="section-header" style={{ marginTop: '30px', marginBottom: '20px' }}>
              <h3 style={{ color: '#9c27b0', display: 'flex', alignItems: 'center', gap: '10px' }}>
                🤖 User-Summoned Bots
                <span style={{ fontSize: '0.8em', color: 'rgba(255, 255, 255, 0.6)' }}>
                  ({chatbots.filter(bot => bot.is_temporary).length} active)
                </span>
              </h3>
            </div>
            <div className="bots-grid">
              {chatbots.filter(bot => bot.is_temporary).map(bot => (
                <div key={bot.id} className={`bot-card ${bot.is_enabled ? 'enabled' : 'disabled'}`} 
                     style={{ borderColor: '#9c27b0', borderWidth: '2px' }}>
                  <div className="bot-header">
                    <span className="bot-name">
                      {bot.show_robot_emoji && '🤖 '}{bot.name}
                      <span style={{ marginLeft: '8px', fontSize: '0.8em', color: '#9c27b0' }}>✨ Summoned</span>
                    </span>
                    <span className={`status-badge ${bot.is_connected ? 'connected' : 'disconnected'}`}>
                      {bot.is_connected ? '● Connected' : '○ Disconnected'}
                    </span>
                  </div>
                  
                  <div className="bot-info">
                    <div className="info-row" style={{ color: '#9c27b0', fontWeight: 'bold' }}>
                      <span>⏱️ Time Remaining:</span>
                      {editingTimeRemaining[bot.id] !== undefined ? (
                        <div style={{ display: 'flex', gap: '5px', alignItems: 'center' }}>
                          <input
                            type="number"
                            value={editingTimeRemaining[bot.id]}
                            onChange={(e) => setEditingTimeRemaining({...editingTimeRemaining, [bot.id]: e.target.value})}
                            style={{ width: '60px', padding: '2px 5px' }}
                            placeholder="Minutes"
                          />
                          <span>min</span>
                          <button
                            onClick={() => handleExtendTime(bot.id, parseInt(editingTimeRemaining[bot.id]))}
                            style={{ padding: '2px 8px', fontSize: '0.8em' }}
                          >
                            ✓
                          </button>
                          <button
                            onClick={() => {
                              const newEditing = {...editingTimeRemaining};
                              delete newEditing[bot.id];
                              setEditingTimeRemaining(newEditing);
                            }}
                            style={{ padding: '2px 8px', fontSize: '0.8em' }}
                          >
                            ✗
                          </button>
                        </div>
                      ) : (
                        <span 
                          onClick={() => setEditingTimeRemaining({...editingTimeRemaining, [bot.id]: '60'})}
                          style={{ cursor: 'pointer', textDecoration: 'underline' }}
                          title="Click to edit time"
                        >
                          {bot.time_remaining_display || 'Unknown'}
                        </span>
                      )}
                    </div>
                    <div className="info-row">
                      <span>Summoned by:</span>
                      <span>{bot.summoned_by || 'Unknown'}</span>
                    </div>
                    <div className="info-row">
                      <span>Status:</span>
                      <span>{bot.is_enabled ? 'Enabled' : 'Disabled'}</span>
                    </div>
                  </div>
                  
                  {bot.personality_prompt && (
                    <div className="bot-prompt" style={{ borderTop: '1px solid rgba(156, 39, 176, 0.2)', paddingTop: '10px', marginTop: '10px' }}>
                      <strong style={{ color: '#9c27b0' }}>User's Personality Request:</strong> {bot.personality_prompt}
                    </div>
                  )}
                  
                  <div className="bot-prompt" style={{ marginTop: '10px' }}>
                    <strong style={{ color: '#9c27b0' }}>Full System Prompt:</strong>
                    <div style={{ marginTop: '5px', padding: '10px', background: 'rgba(156, 39, 176, 0.05)', borderRadius: '4px', fontSize: '0.9em' }}>
                      {bot.prompt || 'No prompt configured'}
                    </div>
                  </div>
                  
                  {bot.last_message && (
                    <div className="bot-last-message">
                      <div className="last-message-header">
                        <span className="last-message-label">Last message:</span>
                        {bot.last_message_at && (
                          <span className="last-message-time">
                            {formatMessageTime(bot.last_message_at)}
                          </span>
                        )}
                      </div>
                      <div className="last-message-text">{bot.last_message}</div>
                    </div>
                  )}
                  
                  <div className="bot-actions">
                    <button 
                      className={`btn ${bot.is_enabled ? 'btn-warning' : 'btn-success'}`}
                      onClick={() => handleToggle(bot.id)}
                    >
                      {bot.is_enabled ? '⏸️ Disable' : '▶️ Enable'}
                    </button>
                    <button 
                      className="btn btn-primary"
                      onClick={() => startEdit(bot)}
                    >
                      ✏️ Edit
                    </button>
                    <button 
                      className="btn btn-secondary"
                      onClick={() => handleTest(bot.id)}
                    >
                      🧪 Test
                    </button>
                    <button 
                      className="btn btn-danger"
                      onClick={() => handleDelete(bot.id)}
                      title="Delete this temporary bot immediately"
                    >
                      🗑️ Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
        
        {/* Regular Bots Section */}
        {chatbots.filter(bot => !bot.is_temporary).length > 0 && (
          <>
            <div className="section-header" style={{ marginTop: '30px', marginBottom: '20px' }}>
              <h3 style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                🤖 System Bots
                <span style={{ fontSize: '0.8em', color: 'rgba(255, 255, 255, 0.6)' }}>
                  ({chatbots.filter(bot => !bot.is_temporary).length} total)
                </span>
              </h3>
            </div>
            <div className="bots-grid">
              {chatbots.filter(bot => !bot.is_temporary).map(bot => (
            <div key={bot.id} className={`bot-card ${bot.is_enabled ? 'enabled' : 'disabled'}`}>
              <div className="bot-header">
                <span className="bot-name">
                  {bot.show_robot_emoji && '🤖 '}{bot.name}
                  {!bot.use_assigned_name && <span className="name-mode"> (random)</span>}
                </span>
                <span className={`status-badge ${bot.is_connected ? 'connected' : 'disconnected'}`}>
                  {bot.is_connected ? '● Connected' : '○ Disconnected'}
                </span>
              </div>
              
              <div className="bot-info">
                <div className="info-row">
                  <span>Response interval:</span>
                  <span>{bot.response_interval_min}-{bot.response_interval_max}s</span>
                </div>
                <div className="info-row">
                  <span>Status:</span>
                  <span>{bot.is_enabled ? 'Enabled' : 'Disabled'}</span>
                </div>
                <div className="info-row">
                  <span>Model:</span>
                  <span className="model-badge">{bot.llm_model || 'Global Default'}</span>
                </div>
                {bot.moviebot_enabled && (
                  <div className="info-row">
                    <span>🎬 MovieBot:</span>
                    <span style={{color: '#4CAF50'}}>ACTIVE</span>
                  </div>
                )}
              </div>
              
              {bot.last_message && (
                <div className="bot-last-message">
                  <div className="last-message-header">
                    <span className="last-message-label">Last message:</span>
                    {bot.last_message_at && (
                      <span className="last-message-time">
                        {formatMessageTime(bot.last_message_at)}
                      </span>
                    )}
                  </div>
                  <div className="last-message-text">{bot.last_message}</div>
                </div>
              )}
              
              <div className="bot-prompt">{bot.prompt.substring(0, 100)}...</div>
              
              <div className="bot-traits">
                {bot.personality_traits?.enthusiasm && <span className="trait">Enthusiastic</span>}
                {bot.personality_traits?.casual && <span className="trait">Casual</span>}
                {bot.personality_traits?.supportive && <span className="trait">Supportive</span>}
                {bot.personality_traits?.humorous && <span className="trait">Humorous</span>}
                {bot.personality_traits?.curious && <span className="trait">Curious</span>}
              </div>
              
              <div className="bot-actions">
                <button onClick={() => handleToggle(bot.id)} className="btn btn-small">
                  {bot.is_enabled ? 'Disable' : 'Enable'}
                </button>
                <button onClick={() => handleToggleMovieBot(bot.id)} className={`btn btn-small ${bot.moviebot_enabled ? 'btn-secondary' : ''}`}>
                  🎬 {bot.moviebot_enabled ? 'MovieBot ON' : 'MovieBot OFF'}
                </button>
                <button onClick={() => handleSendMessage(bot.id)} className="btn btn-small btn-primary">
                  📤 Send
                </button>
                <button onClick={() => handleTest(bot.id)} className="btn btn-small">Test</button>
                <button onClick={() => startEdit(bot)} className="btn btn-small">Edit</button>
                <button onClick={() => fetchBotHistory(bot.id)} className="btn btn-small">History</button>
                <button onClick={() => handleDelete(bot.id)} className="btn btn-small btn-danger">Delete</button>
              </div>
            </div>
          ))}
            </div>
          </>
        )}
      </div>

      {/* Create/Edit Form */}
      {(showCreateForm || editingBot) && (
        <div className="bot-form-overlay">
          <div className="bot-form">
            <h3>
              {editingBot ? (
                <>
                  Edit Chatbot
                  {editingBot.is_temporary && (
                    <span style={{ 
                      marginLeft: '10px', 
                      fontSize: '0.8em', 
                      color: '#9c27b0',
                      padding: '2px 8px',
                      background: 'rgba(156, 39, 176, 0.1)',
                      borderRadius: '4px'
                    }}>
                      ✨ User-Summoned Bot
                    </span>
                  )}
                </>
              ) : 'Create New Chatbot'}
            </h3>
            
            {editingBot?.is_temporary && (
              <div style={{ 
                background: 'rgba(156, 39, 176, 0.1)', 
                border: '1px solid rgba(156, 39, 176, 0.3)',
                borderRadius: '6px',
                padding: '12px',
                marginBottom: '20px'
              }}>
                <div style={{ marginBottom: '8px' }}>
                  <strong>Summoned by:</strong> {editingBot.summoned_by || 'Unknown'}
                </div>
                <div style={{ marginBottom: '8px' }}>
                  <strong>Time Remaining:</strong> {editingBot.time_remaining_display || 'Unknown'}
                </div>
                {editingBot.personality_prompt && (
                  <div>
                    <strong>User's Original Request:</strong> {editingBot.personality_prompt}
                  </div>
                )}
              </div>
            )}
            
            <div className="form-group">
              <label>Name (leave empty for random)</label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="e.g., FriendlyBot or leave empty for Lion1234"
              />
            </div>
            
            <div className="form-group">
              <label>System Prompt</label>
              <div className="prompt-templates">
                {promptTemplates.map(template => (
                  <button
                    key={template.label}
                    onClick={() => setFormData({ ...formData, prompt: template.prompt })}
                    className="template-btn"
                  >
                    {template.label}
                  </button>
                ))}
              </div>
              <textarea
                value={formData.prompt}
                onChange={(e) => setFormData({ ...formData, prompt: e.target.value })}
                rows={4}
              />
            </div>
            
            <div className="form-row">
              <div className="form-group">
                <label>Min Response Interval (seconds)</label>
                <input
                  type="number"
                  value={formData.response_interval_min}
                  onChange={(e) => setFormData({ ...formData, response_interval_min: parseInt(e.target.value) })}
                  min="10"
                  max="600"
                />
              </div>
              
              <div className="form-group">
                <label>Max Response Interval (seconds)</label>
                <input
                  type="number"
                  value={formData.response_interval_max}
                  onChange={(e) => setFormData({ ...formData, response_interval_max: parseInt(e.target.value) })}
                  min="10"
                  max="600"
                />
              </div>
            </div>
            
            <div className="form-group">
              <label>
                <input
                  type="checkbox"
                  checked={formData.show_robot_emoji}
                  onChange={(e) => setFormData({ ...formData, show_robot_emoji: e.target.checked })}
                />
                Show robot emoji in chat
              </label>
            </div>
            
            <div className="form-group">
              <label>
                <input
                  type="checkbox"
                  checked={formData.use_assigned_name}
                  onChange={(e) => setFormData({ ...formData, use_assigned_name: e.target.checked })}
                />
                Use assigned name (unchecked = random animal name)
              </label>
            </div>
            
            <div className="form-group">
              <label>
                <input
                  type="checkbox"
                  checked={formData.moviebot_enabled}
                  onChange={(e) => setFormData({ ...formData, moviebot_enabled: e.target.checked })}
                />
                🎬 Enable MovieBot (bot will comment on film content)
              </label>
            </div>
            
            <div className="form-group">
              <label>LLM Model (Leave as "Global Default" to use system-wide model)</label>
              <select
                value={formData.llm_model || ''}
                onChange={(e) => setFormData({ ...formData, llm_model: e.target.value || null })}
                className="model-select"
              >
                <option value="">Global Default ({currentModel?.info.displayName || 'Loading...'})</option>
                <optgroup label="Ultra-Fast Models (< 1GB)">
                  <option value="qwen2.5:0.5b">Qwen 2.5 0.5B - Ultra-lightweight (400 MB)</option>
                  <option value="tinyllama">TinyLlama 1.1B - Extremely fast (700 MB)</option>
                </optgroup>
                <optgroup label="Fast Models (1-2GB)">
                  <option value="llama3.2:1b">Llama 3.2 1B - Very fast (1.3 GB)</option>
                  <option value="gemma2:2b">Gemma 2 2B - Google's efficient (1.6 GB)</option>
                  <option value="deepseek-r1:1.5b">DeepSeek R1 1.5B - Reasoning-focused (1.0 GB)</option>
                </optgroup>
                <optgroup label="Balanced Models (2-4GB)">
                  <option value="llama3.2:3b">Llama 3.2 3B - Balanced (2.0 GB)</option>
                  <option value="phi3.5:3.8b">Phi 3.5 3.8B - Microsoft's efficient (2.2 GB)</option>
                  <option value="codellama:7b">CodeLlama 7B - Code-specialized (3.8 GB)</option>
                </optgroup>
                <optgroup label="High-Quality Models (4-8GB)">
                  <option value="mistral">Mistral 7B - High-quality (4.1 GB)</option>
                  <option value="llama3.1:8b">Llama 3.1 8B - General purpose (4.7 GB)</option>
                  <option value="qwen2.5:7b">Qwen 2.5 7B - Good reasoning (4.4 GB)</option>
                  <option value="deepseek-r1:7b">DeepSeek R1 7B - Advanced reasoning (4.1 GB)</option>
                </optgroup>
                <optgroup label="Large Models (8GB+)">
                  <option value="deepseek-r1:14b">DeepSeek R1 14B - Excellent performance (8.1 GB)</option>
                  <option value="qwen2.5:14b">Qwen 2.5 14B - Strong reasoning (8.7 GB)</option>
                  <option value="solar:10.7b">Solar 10.7B - Efficient mid-size (6.1 GB)</option>
                  <option value="llama3.3:70b">Llama 3.3 70B - Large model (40 GB, requires significant VRAM)</option>
                </optgroup>
              </select>
              <small className="form-help">
                Different models have different personalities and response styles. Smaller models are faster but less sophisticated.
              </small>
            </div>
            
            <div className="form-group">
              <label>Personality Traits</label>
              <div className="traits-grid">
                <label>
                  <input
                    type="checkbox"
                    checked={formData.personality_traits.enthusiasm}
                    onChange={(e) => setFormData({
                      ...formData,
                      personality_traits: { ...formData.personality_traits, enthusiasm: e.target.checked }
                    })}
                  />
                  Enthusiastic
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={formData.personality_traits.casual}
                    onChange={(e) => setFormData({
                      ...formData,
                      personality_traits: { ...formData.personality_traits, casual: e.target.checked }
                    })}
                  />
                  Casual
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={formData.personality_traits.supportive}
                    onChange={(e) => setFormData({
                      ...formData,
                      personality_traits: { ...formData.personality_traits, supportive: e.target.checked }
                    })}
                  />
                  Supportive
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={formData.personality_traits.humorous}
                    onChange={(e) => setFormData({
                      ...formData,
                      personality_traits: { ...formData.personality_traits, humorous: e.target.checked }
                    })}
                  />
                  Humorous
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={formData.personality_traits.curious}
                    onChange={(e) => setFormData({
                      ...formData,
                      personality_traits: { ...formData.personality_traits, curious: e.target.checked }
                    })}
                  />
                  Curious
                </label>
              </div>
            </div>
            
            <div className="form-group">
              <label>Response Creativity (Temperature: {formData.personality_traits.temperature})</label>
              <input
                type="range"
                min="0.1"
                max="1.0"
                step="0.1"
                value={formData.personality_traits.temperature}
                onChange={(e) => setFormData({
                  ...formData,
                  personality_traits: { ...formData.personality_traits, temperature: parseFloat(e.target.value) }
                })}
              />
              <div className="temperature-labels">
                <span>Conservative</span>
                <span>Balanced</span>
                <span>Creative</span>
              </div>
            </div>
            
            <div className="form-actions">
              <button 
                onClick={editingBot ? handleUpdate : handleCreate}
                className="btn btn-primary"
              >
                {editingBot ? 'Update' : 'Create'}
              </button>
              <button 
                onClick={() => {
                  setShowCreateForm(false);
                  setEditingBot(null);
                  resetForm();
                }}
                className="btn"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Message History Modal */}
      {selectedBotHistory && (
        <div className="history-overlay">
          <div className="history-modal">
            <h3>Message History & Prompt Logs</h3>
            <div className="history-messages">
              {selectedBotHistory.messages.map(msg => (
                <div key={msg.id} className="history-message">
                  <div className="message-header">
                    <span className="history-time">
                      {new Date(msg.created_at).toLocaleString()}
                    </span>
                  </div>
                  <div className="message-content">
                    <div className="response-section">
                      <strong>Response:</strong> {msg.message}
                    </div>
                    {msg.exact_prompt && (
                      <details className="prompt-details" open>
                        <summary>Exact Prompt Sent to Model</summary>
                        <pre className="prompt-text">{msg.exact_prompt}</pre>
                      </details>
                    )}
                    {msg.context && (
                      <details className="prompt-details">
                        <summary>Chat Context</summary>
                        <pre className="prompt-text">{JSON.stringify(JSON.parse(msg.context), null, 2)}</pre>
                      </details>
                    )}
                  </div>
                </div>
              ))}
              {selectedBotHistory.messages.length === 0 && (
                <div className="no-messages">No message history found for this bot.</div>
              )}
            </div>
            <button onClick={() => setSelectedBotHistory(null)} className="btn">Close</button>
          </div>
        </div>
      )}

      {/* MovieBot Logs Modal */}
      {movieBotLogsModal && (
        <div className="bot-form-overlay">
          <div className="moviebot-logs-modal">
            <div className="modal-header">
              <h3>🎬 MovieBot Live Prompt Logs</h3>
              <div className="modal-header-actions">
                <span className="live-indicator">🔴 Live Updates</span>
                <button onClick={closeMovieBotLogsModal} className="btn btn-secondary">× Close</button>
              </div>
            </div>
            <div className="logs-container">
              {movieBotLogs.length > 0 ? (
                movieBotLogs.slice().reverse().map((log: any, index: number) => (
                  <div key={index} className="log-entry">
                    <div className="log-header">
                      <span className="log-time">{new Date(log.timestamp).toLocaleString()}</span>
                      {log.bot && <span className="log-bot">🤖 {log.bot}</span>}
                      <span className="log-event">{log.event || 'PROMPT'}</span>
                    </div>
                    {log.transcription && (
                      <div className="log-section">
                        <strong>🎙️ Transcription ({log.transcription.length} chars):</strong>
                        <div className="transcription-text">{log.transcription}</div>
                      </div>
                    )}
                    {log.fullPrompt && (
                      <details className="prompt-details">
                        <summary>📋 Full Prompt ({log.promptLength || log.fullPrompt.length} chars)</summary>
                        <pre className="prompt-text">{log.fullPrompt}</pre>
                      </details>
                    )}
                    {log.data && log.event && (
                      <div className="log-section">
                        <strong>📄 Event Data:</strong>
                        <pre className="event-data">{JSON.stringify(log.data, null, 2)}</pre>
                      </div>
                    )}
                  </div>
                ))
              ) : (
                <div className="no-messages">
                  <div className="loading-indicator">🔄 Waiting for MovieBot activity...</div>
                  <div className="help-text">Logs will appear here when MovieBot starts processing transcriptions</div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ChatBotManagement;