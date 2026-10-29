export const WORDS = [
  'apple','banana','pineapple','watermelon','strawberry','pizza','burger','sandwich','popcorn','donut','cupcake','ice cream','pancake','cookie','avocado','sushi','taco','cheese','carrot','broccoli',
  'cat','dog','elephant','giraffe','penguin','dolphin','octopus','shark','turtle','butterfly','spider','panda','lion','tiger','monkey','kangaroo','rabbit','snake','horse','owl','whale','flamingo','parrot',
  'car','bicycle','motorcycle','airplane','helicopter','rocket','train','bus','ship','submarine','skateboard','ambulance','tractor','traffic light','hot air balloon','spaceship',
  'house','castle','school','office','hospital','lighthouse','bridge','skyscraper','igloo','tent','treehouse','windmill','volcano','mountain','island','waterfall','desert','river','beach','rainbow',
  'sun','moon','star','cloud','rain','snowman','lightning','tornado','planet','saturn','comet','meteor','alien','astronaut','robot','ufo','telescope','satellite','galaxy',
  'computer','keyboard','mouse','headphones','phone','camera','television','game controller','smartwatch','microphone','speaker','printer','battery','light bulb','remote control',
  'pencil','paintbrush','book','backpack','scissors','clock','umbrella','toothbrush','pillow','blanket','mirror','chair','table','sofa','lamp','door','window','key','lock','ladder','hammer',
  'guitar','piano','drum','violin','trumpet','saxophone','flute','music note','disco ball','trophy','medal','football','basketball','tennis racket','baseball bat','skating','surfboard',
  'pirate','ninja','wizard','superhero','dragon','unicorn','mermaid','ghost','vampire','zombie','dinosaur','treasure chest','crown','sword','shield','magic wand','crystal ball',
  'birthday cake','gift','balloon','fireworks','christmas tree','snowflake','pumpkin','candy cane','heart','diamond','flower','cactus','mushroom','sunflower','rose','palm tree',
  'coffee','tea cup','milkshake','water bottle','toaster','refrigerator','microwave','washing machine','vacuum cleaner','frying pan','spoon','fork','knife','plate','shopping cart',
  'detective','chef','doctor','scientist','firefighter','pilot','artist','teacher','police officer','construction worker','farmer','photographer','magician','singer','dancer'
];

export function normalizeGuess(value) {
  return String(value || '').toLowerCase().normalize('NFKC').replace(/[^a-z0-9]/g, '');
}
export function pickWords(count = 3, random = Math.random) {
  const pool = [...WORDS];
  const result = [];
  while (pool.length && result.length < count) {
    result.push(pool.splice(Math.floor(random() * pool.length), 1)[0]);
  }
  return result;
}
export function hiddenWord(word, hintCount = 0) {
  const letters = [...word].map((ch, i) => /[a-zA-Z0-9]/.test(ch) ? i : -1).filter(i => i >= 0);
  const shown = new Set(letters.slice().sort((a, b) => ((a * 17 + word.length * 7) % 23) - ((b * 17 + word.length * 7) % 23)).slice(0, hintCount));
  return [...word].map((ch, i) => /[a-zA-Z0-9]/.test(ch) && !shown.has(i) ? '_' : ch).join(' ');
}
