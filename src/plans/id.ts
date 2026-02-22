const ADJECTIVES = [
  "bold", "bright", "calm", "clever", "cool", "crisp", "dazzling", "eager",
  "fierce", "gentle", "happy", "keen", "lively", "mellow", "neat", "noble",
  "plucky", "quick", "radiant", "sharp", "silent", "sleek", "smooth", "snappy",
  "steady", "swift", "vivid", "warm", "witty", "zen",
];

const NOUNS = [
  "badger", "bear", "crane", "dolphin", "eagle", "falcon", "fox", "hawk",
  "heron", "jaguar", "kite", "lark", "lynx", "marten", "otter", "owl",
  "panda", "raven", "robin", "salmon", "sparrow", "stork", "swift", "tiger",
  "viper", "whale", "wolf", "wren", "yak", "zebra",
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function generatePlanId(): string {
  const adj = pick(ADJECTIVES);
  const noun = pick(NOUNS);
  const num = Math.floor(Math.random() * 100);
  return `${adj}-${noun}-${num}`;
}
