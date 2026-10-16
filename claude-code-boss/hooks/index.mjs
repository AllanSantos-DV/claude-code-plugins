// The plugin's one hooks module (the engine takes a single entry in hooks.json "modules"):
// each feature keeps its own file and registers its hooks here.
//   compaction.mjs — controlled compaction
//   boss.mjs       — the band above the prompt and /boss

import { register as registerCompaction } from './compaction.mjs';
import { register as registerBoss } from './boss.mjs';

export const register = (on, options) => {
  registerCompaction(on, options);
  registerBoss(on, options);
};
