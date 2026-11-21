// Game mode names and colours. Shared by the data scripts (Node) and the site (browser).
// key = official API mode id. Unknown modes still work: name is derived from the id.
export const MODE_INFO = {
  gemGrab: ['Gem Grab', '#a64cf0'],
  brawlBall: ['Brawl Ball', '#8ca0e0'],
  heist: ['Heist', '#d65cd3'],
  bounty: ['Bounty', '#24d6ff'],
  knockout: ['Knockout', '#f7831c'],
  hotZone: ['Hot Zone', '#e33b50'],
  wipeout: ['Wipeout', '#3fb4ff'],
  brawlHockey: ['Brawl Hockey', '#4fd1e8'],
  airHockey: ['Air Hockey', '#4fd1e8'],
  brawlArena: ['Brawl Arena', '#c94fe0'],
  deathmatch: ['Deathmatch', '#e84f6a'],
  deathmatch5V5: ['Deathmatch 5v5', '#e84f6a'],
  treasureHunt: ['Treasure Hunt', '#e8c84f'],
  bombHeist: ['Bomb Heist', '#d65cd3'],
  killConfirmed: ['Kill Confirmed', '#e8704f'],
  basketBrawl: ['Basket Brawl', '#ff9a3c'],
  volleyBrawl: ['Volley Brawl', '#ffd23c'],
  payload: ['Payload', '#e5b53a'],
  presentPlunder: ['Present Plunder', '#e0533d'],
  holdTheTrophy: ['Hold the Trophy', '#e8b33c'],
  trophyThieves: ['Trophy Thieves', '#e8b33c'],
  gemGrab5V5: ['Gem Grab 5v5', '#a64cf0'],
  brawlBall5V5: ['Brawl Ball 5v5', '#8ca0e0'],
  knockout5V5: ['Knockout 5v5', '#f7831c'],
  wipeout5V5: ['Wipeout 5v5', '#3fb4ff'],
  soloShowdown: ['Solo Showdown', '#81d621'],
  duoShowdown: ['Duo Showdown', '#81d621'],
  trioShowdown: ['Trio Showdown', '#81d621'],
  duels: ['Duels', '#ff3c5c'],
};
// Modes that make up the Ranked map pool.
export const RANKED_MODES = new Set(['gemGrab', 'brawlBall', 'heist', 'bounty', 'knockout', 'hotZone']);

export function modeName(id) {
  if (MODE_INFO[id]) return MODE_INFO[id][0];
  return String(id || 'Unknown').replace(/(\d)V(\d)/g, '$1v$2').replace(/([a-z])([A-Z]|\d+v\d+)/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}
// Modes with no fixed teams: the site has no picks for these.
export const isSoloMode = (id) => /showdown|duels|bossFight|roboRumble|bigGame/i.test(String(id));
export const modeColor = (id) => MODE_INFO[id]?.[1] || '#9a8fc0';
