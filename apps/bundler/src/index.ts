import launcher from '../../app/public/preview-launcher.html';
import { handleBundler } from './bundler.js';

export default {
  fetch: (request: Request): Response | Promise<Response> => handleBundler(request, launcher),
};
