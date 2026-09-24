// electron-builder afterPack hook: flips Electron fuses on the packaged binary so the
// installed app cannot be turned into a debuggable/scriptable Node process.
const path = require('node:path');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

module.exports = async function afterPack(context) {
  const { electronPlatformName, appOutDir, packager } = context;
  const productFilename = packager.appInfo.productFilename;
  const binaryByPlatform = {
    win32: `${productFilename}.exe`,
    linux: packager.executableName || productFilename,
    darwin: `${productFilename}.app`,
  };
  const binary = path.join(appOutDir, binaryByPlatform[electronPlatformName]);

  await flipFuses(binary, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: electronPlatformName === 'darwin',
    [FuseV1Options.RunAsNode]: false, // ELECTRON_RUN_AS_NODE
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false, // NODE_OPTIONS
    [FuseV1Options.EnableNodeCliInspectArguments]: false, // --inspect / --inspect-brk
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  });
};
