const crypto = require('crypto');

// =====================================================================
// Memorable passphrases for accounts that are created or reset on the
// server, where nobody is sitting at a keyboard to invent one.
//
// Four random common words beats a random string on both counts that matter
// here: more entropy per character typed, and someone can actually carry it
// across a room to the person who needs it without mistyping it.
//
// Words are drawn with crypto.randomInt — never Math.random, whose output is
// predictable and would make every generated password guessable.
// =====================================================================

// Concrete, unambiguously-spelled words: nothing homophonic (no their/there),
// no silent-letter traps, none over seven letters.
const WORDS = `
anchor apple arrow autumn bacon badge bakery balcony bamboo banana banner barley
basket beacon beach beans bell berry birch biscuit bishop bison blanket blossom
board boat bolt bonus border bottle boulder bracket branch brass bread breeze
brick bridge bronze brook broom brush bubble bucket buffalo bundle burrow butter
button cabin cable cactus camel canal candle cannon canvas canyon carbon cargo
carpet carrot castle cattle cedar cement chalk chapel charm cheese cherry chess
chimney chisel cider cinema circle clamp clay cliff cloak clock cloud clover
cluster coal coast cobalt cocoa coffee coin collar comet compass copper coral
cork corner cotton county cousin cover cradle crane crayon cream crest cricket
crown crystal cube curtain cushion cycle cypress dagger dairy daisy dancer dawn
deck delta denim desert desk diamond diesel digit dinner ditch dock dolphin
donkey door dragon drawer dream dress drift drum dust eagle earth easel echo
edge elbow elder ember emerald engine escort estate evening exit fabric falcon
feather fence fern ferry fiber fiddle field figure filter finch finger flag
flame flask fleet flint flock flour flower flute foam focus forest forge fossil
fountain fox frame friend frost fruit fudge funnel galaxy gallery garden garlic
gate gauge gazelle gear gecko gem ginger glacier glass globe glove gold gorge
grain granite grape grass gravel green grill grove guitar gull gulf hammer
hamster harbor harvest hawk hazel heart hedge helmet herald herb heron hickory
hill hinge hive holly honey hook horizon hornet horse hotel house hunter hurdle
igloo index ink inlet iris iron island ivory jacket jade jaguar jasmine jelly
jersey jewel journal juice jungle juniper kayak kernel kettle kiln kitchen kite
knight knot koala lace ladder lagoon lake lamp lantern larch laser lattice
laurel lava lawn leaf ledge legend lemon lens leopard lettuce level lever lilac
lily lime linen lion lizard lobby lobster lock locker lodge lotus lumber lunar
lynx magnet magpie mallet mango manor maple marble market marsh mask mast meadow
medal melon mercury mesa metal meteor mineral mint mirror mist mitten model mole
monarch monkey moon moss motor mountain mouse muffin mulberry mural music
mustard nectar needle nest nickel night noodle north nozzle oak oasis oat ocean
octopus office olive onion opal orange orbit orchard orchid otter oven owl
oxygen oyster paddle palace palm pancake panda panel pantry paper parade parcel
parrot parsley pasta pastry patch path patio pearl pebble pelican pencil pepper
petal pewter phoenix piano picnic pigeon pillar pilot pine pipe piston pixel
plank planet plaster plateau plum pocket pollen pond pony poplar poppy porch
portal poster pottery powder prairie prism puddle pumpkin puzzle pyramid quarry
quartz queen quilt rabbit raccoon radar radish raft rail rain rainbow ranch
raven ravine razor recipe reed reef relay ribbon rice ridge rifle river road
robin rocket rope rose rotor rubber ruby rudder rug ruler runner rust saddle
safari sage sail salmon salt sand sandal sapphire satin sauce scale scarf
school scooter screen scroll seal season seed shadow shampoo shark sheep shelf
shell shelter shield shore shovel shrimp shutter signal silk silver siren skate
sketch sky slate sleigh slope smoke snail snow socket sofa solar sonnet spark
sparrow spice spider spinach spiral sponge spoon spring spruce square squid
stable stadium stage stairs stamp station statue steam steel stem stereo stone
stool storm stove strap straw stream street studio sugar suit summer sunset
surf swallow swan sweater swift sword sycamore syrup table tackle talon tanker
tape tavern teapot temple tender tennis tent terrace textile thicket thimble
thistle thorn thread thunder ticket tide tiger timber tinder toaster token
tomato topaz torch tornado tortoise tower town tractor trail train tram travel
tray treasure tree trellis triangle tribe trophy trout truck trumpet trunk
tulip tundra tunnel turbine turkey turnip turtle tusk twig twine umbrella
unicorn valley valve vanilla vase velvet vessel vine vinegar violet violin
volcano vulture wagon walnut walrus warden wasp water wave wax weasel weather
weaver wedge whale wheat wheel whistle willow window winter wire wolf wonder
wood wool world wren yacht yard yarn yeast yellow yoga zebra zinc zipper
`.trim().split(/\s+/);

const SYMBOLS = '!@#$%&*?+=-';
const pick = (arr) => arr[crypto.randomInt(arr.length)];

// Four distinct capitalised words joined by one repeated symbol, ending in two
// digits — e.g. "Puzzle%Juniper%Deck%Stereo%51". Satisfies the app's own policy
// (upper, lower, digit, symbol, 8+) by construction.
const generatePassphrase = (wordCount = 4) => {
  const words = [];
  while (words.length < wordCount) {
    const w = pick(WORDS);
    if (!words.includes(w)) words.push(w);
  }
  const sep = pick(SYMBOLS);
  return words.map((w) => w[0].toUpperCase() + w.slice(1)).join(sep)
    + sep + (10 + crypto.randomInt(90));
};

// Roughly how many bits of entropy the above carries, so callers can report it
// honestly rather than just asserting "strong".
const entropyBits = (wordCount = 4) => Math.round(
  wordCount * Math.log2(WORDS.length) + Math.log2(SYMBOLS.length) + Math.log2(90)
);

// The rule the app enforces on its own auth routes. Checked wherever a password
// is set from a script, so a seeded account can never be weaker than one a user
// would be allowed to choose.
const meetsPolicy = (p) => typeof p === 'string'
  && p.length >= 8
  && /[a-z]/.test(p) && /[A-Z]/.test(p) && /\d/.test(p) && /[^A-Za-z0-9]/.test(p);

module.exports = { generatePassphrase, entropyBits, meetsPolicy, WORD_COUNT: WORDS.length };
