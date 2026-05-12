import type { Credentials, AuthStatus, DeviceFlowInitResponse } from '../../../src/types/auth.js';

export const mockCredentials: Credentials = {
  access_token: 'mock-access-token-xxx',
  expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(), // 2 hours from now
  user: {
    email: 'demo@qianwenai.com',
    aliyunId: 'mock_aliyun_id',
  },
};

export const mockAuthStatus: AuthStatus = {
  authenticated: true,
  server_verified: true,
  user: { email: 'demo@qianwenai.com', aliyunId: 'mock_aliyun_id' },
  token: {
    expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    scopes: ['inference:read', 'usage:read', 'config:write'],
  },
};

export const mockDeviceFlowInit: DeviceFlowInitResponse = {
  token: 'mock-encrypt-token-xxx',
  verification_url: 'https://t.qianwenai.com/activate?token=mock-encrypt-token-xxx',
  expires_in: 900,
  interval: 5,
};
