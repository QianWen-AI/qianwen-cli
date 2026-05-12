export interface Credentials {
  access_token: string;
  expires_at: string; // ISO 8601
  user: UserInfo;
}

export interface UserInfo {
  id?: number;
  email: string; // kept for internal use, not displayed in auth status
  aliyunId: string;
}

export interface AuthStatus {
  authenticated: boolean;
  server_verified: boolean; // true = server confirmed token is valid
  auth_mode?: 'device_flow';
  source?: 'keychain' | 'encrypted_file'; // credential source
  warning?: string; // e.g. "Server unreachable, showing local status"
  user?: UserInfo;
  token?: {
    expires_at: string;
    scopes: string[];
  };
}

export interface DeviceFlowInitResponse {
  token: string; // encrypt_token, used for polling
  verification_url: string; // complete URL, CLI uses as-is
  expires_in: number;
  interval: number;
  code_verifier?: string; // PKCE code_verifier, passed from init to poll
}

export interface DeviceFlowPollResponse {
  status: 'authorization_pending' | 'slow_down' | 'access_denied' | 'expired_token' | 'complete';
  credentials?: Credentials;
}
