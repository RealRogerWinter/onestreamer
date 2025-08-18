import axios from 'axios';

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:8080';

interface User {
  id: number;
  email: string;
  username: string;
  isVerified?: boolean;
  isAdmin?: boolean;
  isBanned?: boolean;
  is_verified?: boolean;
  is_admin?: boolean;
  is_banned?: boolean;
}

interface AuthResponse {
  user: User;
  token: string;
  refreshToken: string;
  message?: string;
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

  async signup(email: string, username: string, password: string): Promise<AuthResponse> {
    try {
      const response = await axios.post<AuthResponse>(`${API_URL}/auth/signup`, {
        email,
        username,
        password
      });

      this.token = response.data.token;
      this.refreshToken = response.data.refreshToken;
      this.user = response.data.user;
      this.saveToStorage();

      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.error || 'Signup failed');
    }
  }

  async login(email: string, password: string): Promise<AuthResponse> {
    try {
      const response = await axios.post<AuthResponse>(`${API_URL}/auth/login`, {
        email,
        password
      });

      this.token = response.data.token;
      this.refreshToken = response.data.refreshToken;
      this.user = response.data.user;
      this.saveToStorage();

      return response.data;
    } catch (error: any) {
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
      this.token = null;
      this.refreshToken = null;
      this.user = null;
      this.saveToStorage();
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

  async requestPasswordReset(email: string): Promise<void> {
    await axios.post(`${API_URL}/auth/forgot-password`, { email });
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

  // Admin API methods
  async getUsers(search?: string, limit = 50): Promise<any[]> {
    const params = new URLSearchParams();
    if (search) params.append('search', search);
    if (limit) params.append('limit', limit.toString());

    const response = await axios.get(`${API_URL}/auth/admin/users?${params.toString()}`, {
      headers: { 'Authorization': `Bearer ${this.token}` }
    });
    return response.data.users;
  }

  async promoteUser(userId: number): Promise<void> {
    await axios.post(`${API_URL}/auth/admin/users/${userId}/promote`, {}, {
      headers: { 'Authorization': `Bearer ${this.token}` }
    });
  }

  async demoteUser(userId: number): Promise<void> {
    await axios.post(`${API_URL}/auth/admin/users/${userId}/demote`, {}, {
      headers: { 'Authorization': `Bearer ${this.token}` }
    });
  }

  async banUser(userId: number): Promise<void> {
    await axios.post(`${API_URL}/auth/admin/users/${userId}/ban`, {}, {
      headers: { 'Authorization': `Bearer ${this.token}` }
    });
  }

  async unbanUser(userId: number): Promise<void> {
    await axios.post(`${API_URL}/auth/admin/users/${userId}/unban`, {}, {
      headers: { 'Authorization': `Bearer ${this.token}` }
    });
  }

  async deleteUser(userId: number): Promise<void> {
    await axios.delete(`${API_URL}/auth/admin/users/${userId}`, {
      headers: { 'Authorization': `Bearer ${this.token}` }
    });
  }

  setupAxiosInterceptors() {
    axios.interceptors.request.use(
      (config) => {
        if (this.token && !config.headers['Authorization']) {
          config.headers['Authorization'] = `Bearer ${this.token}`;
        }
        return config;
      },
      (error) => Promise.reject(error)
    );

    axios.interceptors.response.use(
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