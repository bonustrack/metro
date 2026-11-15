const path = require('node:path');

const googleServices = (process.env.GOOGLE_SERVICES_JSON || '').trim();

module.exports = {
  ignorePaths: googleServices === '' ? [] : [path.relative(__dirname, path.resolve(__dirname, googleServices))],
  fileHookTransform(source, chunk) {
    if (source.type !== 'contents' || source.id !== 'expoConfig' || chunk === null) return chunk;
    const config = JSON.parse(chunk.toString());
    delete config.extra?.gitHash;
    delete config.extra?.commitTime;
    delete config.extra?.buildProfile;
    return JSON.stringify(config);
  },
};
