'use strict';

const path = require('path');

/**
 * The build a plugin folder names. Two builds can share a package version; the cache folder is what tells them apart
 * (`<version>` for a release, `<version>-dev.<commit>` for a development install).
 * @param {string} root plugin root folder
 * @param {string} version package.json version
 * @returns {string} the folder name when it names this version, else the version
 */
function buildIdOf(root, version) {
  const name = root ? path.basename(root) : '';
  return name === version || name.startsWith(`${version}-`) ? name : version;
}

module.exports = { buildIdOf };
