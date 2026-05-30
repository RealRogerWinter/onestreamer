export interface PersonalityTraits {
  enthusiasm: boolean;
  casual: boolean;
  supportive: boolean;
  humorous: boolean;
  curious: boolean;
  temperature: number;
}

export interface ChatBot {
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

export interface ChatBotManagementProps {
  addLog: (message: string) => void;
}

export interface MovieBotStatus {
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

export interface ChatBotFormData {
  name: string;
  prompt: string;
  response_interval_min: number;
  response_interval_max: number;
  show_robot_emoji: boolean;
  use_assigned_name: boolean;
  llm_model: string | null;
  moviebot_enabled: boolean;
  personality_traits: PersonalityTraits;
}

export interface PromptTemplate {
  label: string;
  prompt: string;
}
