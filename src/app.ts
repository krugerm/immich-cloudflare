import { Hono } from 'hono';
import { activityRoutes } from './activities/routes';
import { adminRoutes } from './admin/routes';
import { albumRoutes } from './albums/routes';
import { assetManageRoutes } from './assets/manage-routes';
import { duplicateRoutes } from './duplicates/routes'; // phase 4 C
import { downloadRoutes } from './download/routes';
import { trashRoutes } from './trash/routes';
import { assetRoutes } from './assets/routes';
import { authRoutes } from './auth/routes';
import type { AuthContext } from './auth/session';
import { notFound, onError } from './http/errors';
import { jobRoutes } from './jobs/routes';
import { mapRoutes } from './map/routes';
import { searchRoutes } from './search/routes';
import { mediaRoutes } from './media/routes';
import { memoryRoutes } from './memories/routes';
import { configRoutes } from './config/routes';
import { notificationRoutes } from './notifications/routes';
import { partnerRoutes } from './partners/routes';
import { processRoutes } from './process/routes';
import { realtimeRoutes } from './realtime/routes';
import { serverExtraRoutes } from './server/extras';
import { serverRoutes } from './server/routes';
import { sessionRoutes } from './sessions/routes';
import { sharedLinkRoutes } from './shared-links/routes';
import { syncRoutes } from './sync/routes';
import { uploadRoutes } from './upload/routes';
import { stackRoutes } from './stacks/routes';
import { tagRoutes } from './tags/routes';
import { timelineRoutes } from './timeline/routes';
import { viewRoutes } from './views/routes';
import { userExtraRoutes } from './users/extra';
import { userRoutes } from './users/routes';
// stream A
import { adminUserRoutes } from './admin/users';
import { apiKeyRoutes } from './api-keys/routes';
import { accountRoutes } from './auth/account';
import { passwordResetRoutes } from './auth/reset';
import { resetPageRoutes } from './auth/reset-pages';
import { oauthRoutes } from './oauth/routes';
import { meRoutes } from './users/me';
// phase 4 E
import { peopleRoutes } from './people/routes';
import { warmOnAppOpen } from './ml/warm';

export type AppEnv = { Bindings: Env; Variables: { auth: AuthContext } };

export const api = new Hono<AppEnv>();
api.use('*', warmOnAppOpen); // phase 4: wake the search container when an app opens
api.get('/server/ping', (c) => c.json({ res: 'pong' }));
api.route('/', authRoutes);
api.route('/', serverRoutes);
api.route('/', userRoutes);
api.route('/', userExtraRoutes);
api.route('/', sessionRoutes);
api.route('/', adminRoutes);
api.route('/', uploadRoutes);
api.route('/', mediaRoutes);
api.route('/', assetRoutes);
api.route('/', processRoutes);
api.route('/', syncRoutes);
api.route('/', timelineRoutes);
// stream B
api.route('/', assetManageRoutes);
api.route('/', trashRoutes);
api.route('/', downloadRoutes);
// stream E
api.route('/', tagRoutes);
api.route('/', stackRoutes);
// stream F
api.route('/', memoryRoutes);
api.route('/', viewRoutes);
api.route('/', serverExtraRoutes);
api.route('/', jobRoutes);
// stream G
api.route('/', searchRoutes);
api.route('/', mapRoutes);
// stream H
api.route('/', realtimeRoutes);
// stream D
api.route('/', partnerRoutes);
api.route('/', configRoutes);
api.route('/', notificationRoutes);
// stream C
api.route('/', albumRoutes);
api.route('/', sharedLinkRoutes);
api.route('/', activityRoutes);
// stream A
api.route('/', accountRoutes);
api.route('/', apiKeyRoutes);
api.route('/', meRoutes);
api.route('/', adminUserRoutes);
api.route('/', oauthRoutes);
api.route('/', passwordResetRoutes);
// phase 4 C
api.route('/', duplicateRoutes);
// phase 4 E
api.route('/', peopleRoutes);

export const app = new Hono<AppEnv>();
app.get('/.well-known/immich', (c) => c.json({ api: { endpoint: '/api' } }));
app.route('/api', api);
app.route('/', resetPageRoutes);
app.onError(onError);
app.notFound(notFound);
