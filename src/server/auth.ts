import { betterAuth } from 'better-auth';
import { admin } from 'better-auth/plugins';
import { adminAc,userAc } from 'better-auth/plugins/admin/access';

import { limits } from '../../config/settings.ts';

export interface AuthConfig {
  DB: D1Database;
  APP_ORIGIN: string;
  AUTH_SECRET: string;
}
export function createAuth(config: AuthConfig) {
  return betterAuth({
    database: config.DB,
    secret: config.AUTH_SECRET,
    baseURL: config.APP_ORIGIN,
    trustedOrigins: [config.APP_ORIGIN],
    emailAndPassword: {
      enabled: true, minPasswordLength: limits.minPassword, maxPasswordLength: limits.maxPassword,
      requireEmailVerification: false, revokeSessionsOnPasswordReset: true,
    },
    user: {
      additionalFields: {
        role: { type: 'string', required: true, input: false, defaultValue: 'resident' },
        purpose: { type: 'string', required: false, input: false },
      },
    },
    disabledPaths: ['/request-password-reset','/reset-password','/forget-password','/change-email',
      '/send-verification-email','/verify-email','/sign-in/social','/link-social','/update-user','/delete-user'],
    advanced: { useSecureCookies: config.APP_ORIGIN.startsWith('https:') },
    rateLimit: { enabled: false },
    plugins: [admin({defaultRole:'resident',adminRoles:['staff'],roles:{resident:userAc,staff:adminAc}})],

    logger: { disabled: true },
  });
}
