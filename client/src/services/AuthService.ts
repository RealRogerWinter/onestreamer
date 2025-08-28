import axios from 'axios';

const API_URL = process.env.REACT_APP_API_URL || 'https://onestreamer.live';

interface User {
  id: number;
  email: string;
  username: string;
  isVerified?: boolean;
  isAdmin?: boolean;
  isModerator?: boolean;
  isBanned?: boolean;
  is_verified?: boolean;
  is_admin?: boolean;
  is_moderator?: boolean;
  is_banned?: boolean;
  accountStatus?: string;
  account_status?: string;
}

interface AuthResponse {
  user: User;
  token: string;
  refreshToken: string;
  message?: string;
  accountStatus?: string;
}

interface UserStats {
  totalStreamTime: number;
  totalViewTime: number;
  streamCount: number;
  chatMessageCount: number;
  lastStreamAt: string | null;
  points: number;
}

class AuthService {
  private token: string | null = null;
  private refreshToken: string | null = null;
  private user: User | null = null;

  constructor() {
    this.loadFromStorage();
  }

  private loadFromStorage() {
    this.token = localStorage.getItem('auth_token');
    this.refreshToken = localStorage.getItem('refresh_token');
    const userStr = localStorage.getItem('user');
    if (userStr) {
      try {
        this.user = JSON.parse(userStr);
      } catch (e) {
        console.error('Failed to parse user from storage:', e);
      }
    }
  }

  private saveToStorage() {
    if (this.token) {
      localStorage.setItem('auth_token', this.token);
    } else {
      localStorage.removeItem('auth_token');
    }

    if (this.refreshToken) {
      localStorage.setItem('refresh_token', this.refreshToken);
    } else {
      localStorage.removeItem('refresh_token');
    }

    if (this.user) {
      localStorage.setItem('user', JSON.stringify(this.user));
    } else {
      localStorage.removeItem('user');
    }
  }

  async signup(email: string, username: string, password: string, turnstileToken: string): Promise<AuthResponse> {
    try {
      const response = await axios.post<AuthResponse>(`${API_URL}/auth/signup`, {
        email,
        username,
        password,
        turnstileToken
      });

      this.token = response.data.token;
      this.refreshToken = response.data.refreshToken;
      this.user = response.data.user;
      this.saveToStorage();
      
      // Re-setup interceptors with new token
      this.setupAxiosInterceptors();

      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.error || 'Signup failed');
    }
  }

  async login(email: string, password: string, turnstileToken: string): Promise<AuthResponse> {
    try {
      // console.log('🔐 Attempting login with:', { email, passwordLength: password.length });
      
      const response = await axios.post<AuthResponse>(`${API_URL}/auth/login`, {
        email,
        password,
        turnstileToken
      });

      this.token = response.data.token;
      this.refreshToken = response.data.refreshToken;
      this.user = response.data.user;
      
      // Check if account is pending deletion before saving
      if (response.data.accountStatus !== 'pending_deletion') {
        this.saveToStorage();
        // Re-setup interceptors with new token
        this.setupAxiosInterceptors();
      }

      // console.log('✅ Login successful for user:', this.user.username);
      return response.data;
    } catch (error: any) {
      console.error('❌ Login failed:', error.response?.status, error.response?.data);
      throw new Error(error.response?.data?.error || 'Login failed');
    }
  }

  async logout(): Promise<void> {
    try {
      if (this.token) {
        await axios.post(`${API_URL}/auth/logout`, {}, {
          headers: {
            'Authorization': `Bearer ${this.token}`
          }
        });
      }
    } catch (error) {
      console.error('Logout error:', error);
    } finally {
      // Clear all auth data from memory
      this.token = null;
      this.refreshToken = null;
      this.user = null;
      
      // Clear all auth-related data from localStorage
      localStorage.removeItem('auth_token');
      localStorage.removeItem('refresh_token');
      localStorage.removeItem('user');
      
      // Also clear any other potential auth-related items
      const keysToRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && (key.includes('auth') || key.includes('token') || key.includes('user'))) {
          keysToRemove.push(key);
        }
      }
      keysToRemove.forEach(key => localStorage.removeItem(key));
      
      // Remove axios interceptors to prevent any lingering auth attempts
      if (this.requestInterceptor !== null) {
        axios.interceptors.request.eject(this.requestInterceptor);
        this.requestInterceptor = null;
      }
      if (this.responseInterceptor !== null) {
        axios.interceptors.response.eject(this.responseInterceptor);
        this.responseInterceptor = null;
      }
    }
  }

  async refreshAccessToken(): Promise<string | null> {
    if (!this.refreshToken) {
      return null;
    }

    try {
      const response = await axios.post<{ token: string; refreshToken: string }>(`${API_URL}/auth/refresh`, {
        refreshToken: this.refreshToken
      });

      this.token = response.data.token;
      this.refreshToken = response.data.refreshToken;
      this.saveToStorage();
      
      // After refreshing tokens, also fetch fresh profile data to ensure user info is up to date
      try {
        const profile = await this.getProfile();
        if (profile) {
          this.user = profile.user;
          this.saveToStorage();
        }
      } catch (profileError) {
        console.error('Failed to refresh profile after token refresh:', profileError);
      }

      return this.token;
    } catch (error) {
      console.error('Token refresh failed:', error);
      this.logout();
      return null;
    }
  }

  async verifyEmail(token: string): Promise<void> {
    await axios.get(`${API_URL}/auth/verify-email/${token}`);
  }

  async requestPasswordReset(email: string, turnstileToken: string): Promise<void> {
    await axios.post(`${API_URL}/auth/forgot-password`, { email, turnstileToken });
  }

  async resetPassword(resetToken: string, newPassword: string): Promise<void> {
    await axios.post(`${API_URL}/auth/reset-password`, {
      resetToken,
      newPassword
    });
  }

  async getProfile(): Promise<{ user: User; stats: UserStats } | null> {
    if (!this.token) {
      return null;
    }

    try {
      const response = await axios.get<{ user: User; stats: UserStats }>(`${API_URL}/auth/me`, {
        headers: {
          'Authorization': `Bearer ${this.token}`
        }
      });

      this.user = response.data.user;
      this.saveToStorage();

      return response.data;
    } catch (error: any) {
      if (error.response?.status === 401) {
        const newToken = await this.refreshAccessToken();
        if (newToken) {
          return this.getProfile();
        }
      }
      throw error;
    }
  }

  async updateProfile(data: {
    email?: string;
    currentPassword?: string;
    newPassword?: string;
  }): Promise<{ success: boolean; user?: User; message?: string }> {
    if (!this.token) {
      throw new Error('Not authenticated');
    }

    try {
      const response = await axios.put<{ success: boolean; user: User; message?: string }>(
        `${API_URL}/auth/profile`,
        data,
        {
          headers: {
            'Authorization': `Bearer ${this.token}`
          }
        }
      );

      if (response.data.user) {
        this.user = response.data.user;
        this.saveToStorage();
      }

      return response.data;
    } catch (error: any) {
      if (error.response?.status === 401) {
        const newToken = await this.refreshAccessToken();
        if (newToken) {
          return this.updateProfile(data);
        }
      }
      throw new Error(error.response?.data?.error || 'Failed to update profile');
    }
  }

  async changeUsername(newUsername: string): Promise<{ success: boolean; username?: string; message?: string }> {
    if (!this.token) {
      throw new Error('Not authenticated');
    }

    try {
      const response = await axios.put<{ success: boolean; username: string; token: string; refreshToken: string; message?: string }>(
        `${API_URL}/auth/change-username`,
        { newUsername },
        {
          headers: {
            'Authorization': `Bearer ${this.token}`
          }
        }
      );

      // Update tokens with new username
      if (response.data.token && response.data.refreshToken) {
        this.token = response.data.token;
        this.refreshToken = response.data.refreshToken;
        this.saveToStorage();
        
        // Update user object with new username
        if (this.user) {
          this.user.username = response.data.username;
          this.saveToStorage();
        }
      }

      return response.data;
    } catch (error: any) {
      if (error.response?.status === 401) {
        const newToken = await this.refreshAccessToken();
        if (newToken) {
          return this.changeUsername(newUsername);
        }
      }
      throw new Error(error.response?.data?.error || 'Failed to change username');
    }
  }

  async resendVerificationEmail(): Promise<{ success: boolean; message?: string }> {
    if (!this.token) {
      throw new Error('Not authenticated');
    }

    try {
      const response = await axios.post<{ success: boolean; message: string }>(
        `${API_URL}/auth/resend-verification`,
        {},
        {
          headers: {
            'Authorization': `Bearer ${this.token}`
          }
        }
      );

      return response.data;
    } catch (error: any) {
      if (error.response?.status === 401) {
        const newToken = await this.refreshAccessToken();
        if (newToken) {
          return this.resendVerificationEmail();
        }
      }
      throw new Error(error.response?.data?.error || 'Failed to resend verification email');
    }
  }

  googleLogin() {
    window.location.href = `${API_URL}/auth/google`;
  }

  async handleOAuthCallback(): Promise<void> {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    const refreshToken = params.get('refreshToken');

    if (token && refreshToken) {
      this.token = token;
      this.refreshToken = refreshToken;
      this.saveToStorage();

      const profile = await this.getProfile();
      if (profile) {
        this.user = profile.user;
        this.saveToStorage();
      }

      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }

  isAuthenticated(): boolean {
    return !!this.token;
  }

  getToken(): string | null {
    return this.token;
  }

  getUser(): User | null {
    return this.user;
  }

  async isAdmin(): Promise<boolean> {
    // Always fetch fresh user data to check admin status
    try {
      const profile = await this.getProfile();
      if (profile) {
        this.user = profile.user;
        this.saveToStorage();
        return profile.user.isAdmin === true || profile.user.is_admin === true || (profile.user.is_admin as any) === 1;
      }
      return false;
    } catch (error) {
      console.error('Failed to fetch admin status:', error);
      // Fallback to cached data if API call fails
      return this.user?.isAdmin === true || this.user?.is_admin === true || (this.user?.is_admin as any) === 1;
    }
  }

  isAdminSync(): boolean {
    return this.user?.isAdmin === true || this.user?.is_admin === true || (this.user?.is_admin as any) === 1;
  }

  async isModerator(): Promise<boolean> {
    try {
      const response = await axios.get(`${API_URL}/auth/me`, {
        headers: { 'Authorization': `Bearer ${this.token}` }
      });
      const profile = response.data;
      if (profile && profile.user) {
        return profile.user.isModerator === true || profile.user.is_moderator === true || (profile.user.is_moderator as any) === 1 || profile.user.isAdmin === true || profile.user.is_admin === true || (profile.user.is_admin as any) === 1;
      }
      return false;
    } catch (error) {
      // Fallback to cached user data
      return this.user?.isModerator === true || this.user?.is_moderator === true || (this.user?.is_moderator as any) === 1 || this.user?.isAdmin === true || this.user?.is_admin === true || (this.user?.is_admin as any) === 1;
    }
  }

  isModeratorSync(): boolean {
    return this.user?.isModerator === true || this.user?.is_moderator === true || (this.user?.is_moderator as any) === 1 || this.user?.isAdmin === true || this.user?.is_admin === true || (this.user?.is_admin as any) === 1;
  }

  // Admin API methods
  async getUsers(search?: string, limit = 50): Promise<any[]> {
    const params = new URLSearchParams();
    if (search) params.append('search', search);
    if (limit) params.append('limit', limit.toString());

    const response = await axios.get(`${API_URL}/api/admin/users?${params.toString()}`, {
      headers: { 'Authorization': `Bearer ${this.token}` }
    });
    return response.data;
  }

  async promoteUser(userId: number): Promise<void> {
    await axios.post(`${API_URL}/api/admin/users/${userId}/promote-admin`, {}, {
      headers: { 'Authorization': `Bearer ${this.token}` }
    });
  }

  async demoteUser(userId: number): Promise<void> {
    await axios.post(`${API_URL}/api/admin/users/${userId}/demote-admin`, {}, {
      headers: { 'Authorization': `Bearer ${this.token}` }
    });
  }

  async promoteModerator(userId: number): Promise<void> {
    await axios.post(`${API_URL}/api/admin/users/${userId}/promote-moderator`, {}, {
      headers: { 'Authorization': `Bearer ${this.token}` }
    });
  }

  async demoteModerator(userId: number): Promise<void> {
    await axios.post(`${API_URL}/api/admin/users/${userId}/demote-moderator`, {}, {
      headers: { 'Authorization': `Bearer ${this.token}` }
    });
  }

  async banUser(userId: number): Promise<void> {
    await axios.post(`${API_URL}/api/admin/users/${userId}/ban`, {}, {
      headers: { 'Authorization': `Bearer ${this.token}` }
    });
  }

  async unbanUser(userId: number): Promise<void> {
    await axios.post(`${API_URL}/api/admin/users/${userId}/unban`, {}, {
      headers: { 'Authorization': `Bearer ${this.token}` }
    });
  }

  async deleteUser(userId: number): Promise<void> {
    await axios.delete(`${API_URL}/api/admin/users/${userId}`, {
      headers: { 'Authorization': `Bearer ${this.token}` }
    });
  }

  // Account deletion methods
  async requestAccountDeletion(): Promise<any> {
    try {
      const response = await axios.post(`${API_URL}/auth/request-deletion`, {}, {
        headers: { 'Authorization': `Bearer ${this.token}` }
      });
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.error || 'Failed to request account deletion');
    }
  }

  async confirmAccountDeletion(token: string): Promise<any> {
    try {
      const response = await axios.post(`${API_URL}/auth/confirm-deletion`, { token });
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.error || 'Failed to confirm account deletion');
    }
  }

  async restoreAccount(email: string, password: string): Promise<any> {
    try {
      const response = await axios.post(`${API_URL}/auth/restore-account`, {
        email,
        password
      });
      
      if (response.data.token) {
        this.token = response.data.token;
        this.refreshToken = response.data.refreshToken;
        this.user = response.data.user;
        this.saveToStorage();
        this.setupAxiosInterceptors();
      }
      
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.error || 'Failed to restore account');
    }
  }

  private requestInterceptor: number | null = null;
  private responseInterceptor: number | null = null;

  setupAxiosInterceptors() {
    // Remove existing interceptors if any
    if (this.requestInterceptor !== null) {
      axios.interceptors.request.eject(this.requestInterceptor);
    }
    if (this.responseInterceptor !== null) {
      axios.interceptors.response.eject(this.responseInterceptor);
    }
    
    this.requestInterceptor = axios.interceptors.request.use(
      (config) => {
        // Always add token if available, update existing Authorization header
        if (this.token) {
          config.headers['Authorization'] = `Bearer ${this.token}`;
        }
        return config;
      },
      (error) => Promise.reject(error)
    );

    this.responseInterceptor = axios.interceptors.response.use(
      (response) => response,
      async (error) => {
        const originalRequest = error.config;

        if (error.response?.status === 401 && !originalRequest._retry) {
          originalRequest._retry = true;

          const newToken = await this.refreshAccessToken();
          if (newToken) {
            originalRequest.headers['Authorization'] = `Bearer ${newToken}`;
            return axios(originalRequest);
          }
        }

        return Promise.reject(error);
      }
    );
  }
}

const authService = new AuthService();
authService.setupAxiosInterceptors();

export default authService;