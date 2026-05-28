/**
 * AnimalNameGenerator — produces unique "{Adjective} {Animal}" display names
 * for URL-relay stream rotations. Tracks a `usedNames` Set; if the generator
 * runs `maxAttempts` (100) times trying to find a fresh combination it gives
 * up the uniqueness guarantee, clears the cache, and returns whatever it most
 * recently rolled. This is the long-running fallback for when the used-name
 * pool fills up faster than rotations reset it.
 *
 * Construction:
 *   new AnimalNameGenerator({ animals?, adjectives?, maxAttempts? })
 *
 * Defaults to the canonical ANIMALS (160+ entries) and ADJECTIVES (40+ entries)
 * arrays that previously lived at the top of RandomStreamRotationService.js.
 *
 * The main service exposes `this.usedAnimalNames` as a reference to the
 * generator's internal `usedNames` Set so existing call sites like
 * `clearStats() { this.usedAnimalNames.clear(); }` stay byte-equivalent.
 */

const ANIMALS = [
  'Aardvark', 'Albatross', 'Alligator', 'Alpaca', 'Ant', 'Anteater', 'Antelope', 'Armadillo',
  'Badger', 'Bat', 'Bear', 'Beaver', 'Bee', 'Bison', 'Boar', 'Buffalo', 'Butterfly',
  'Camel', 'Capybara', 'Caribou', 'Cat', 'Caterpillar', 'Cheetah', 'Chicken', 'Chimpanzee', 'Chinchilla', 'Cobra', 'Cougar', 'Coyote', 'Crab', 'Crane', 'Crocodile', 'Crow',
  'Deer', 'Dingo', 'Dog', 'Dolphin', 'Donkey', 'Dove', 'Dragonfly', 'Duck',
  'Eagle', 'Echidna', 'Eel', 'Elephant', 'Elk', 'Emu',
  'Falcon', 'Ferret', 'Finch', 'Flamingo', 'Fox', 'Frog',
  'Gazelle', 'Gecko', 'Gerbil', 'Giraffe', 'Goat', 'Goose', 'Gopher', 'Gorilla', 'Grasshopper', 'Grizzly',
  'Hamster', 'Hare', 'Hawk', 'Hedgehog', 'Heron', 'Hippo', 'Hornet', 'Horse', 'Hummingbird', 'Hyena',
  'Iguana', 'Impala',
  'Jackal', 'Jaguar', 'Jellyfish',
  'Kangaroo', 'Koala', 'Kiwi', 'Kookaburra',
  'Lemur', 'Leopard', 'Lion', 'Lizard', 'Llama', 'Lobster', 'Lynx',
  'Manatee', 'Mandrill', 'Meerkat', 'Mink', 'Mole', 'Mongoose', 'Monkey', 'Moose', 'Moth', 'Mouse',
  'Narwhal', 'Newt', 'Nightingale',
  'Ocelot', 'Octopus', 'Opossum', 'Orangutan', 'Orca', 'Ostrich', 'Otter', 'Owl', 'Ox', 'Oyster',
  'Panda', 'Panther', 'Parrot', 'Peacock', 'Pelican', 'Penguin', 'Pheasant', 'Pig', 'Pigeon', 'Platypus', 'Polar Bear', 'Porcupine', 'Porpoise', 'Possum', 'Puma',
  'Quail', 'Quokka',
  'Rabbit', 'Raccoon', 'Ram', 'Raven', 'Reindeer', 'Rhino', 'Robin', 'Rooster',
  'Salamander', 'Salmon', 'Scorpion', 'Sea Lion', 'Seahorse', 'Seal', 'Shark', 'Sheep', 'Shrimp', 'Skunk', 'Sloth', 'Snail', 'Snake', 'Sparrow', 'Spider', 'Squid', 'Squirrel', 'Starfish', 'Stingray', 'Stork', 'Swan',
  'Tapir', 'Tiger', 'Toad', 'Toucan', 'Turkey', 'Turtle',
  'Vulture',
  'Wallaby', 'Walrus', 'Warthog', 'Wasp', 'Weasel', 'Whale', 'Wolf', 'Wolverine', 'Wombat', 'Woodpecker',
  'Yak',
  'Zebra',
];

const ADJECTIVES = [
  'Swift', 'Brave', 'Clever', 'Mighty', 'Gentle', 'Wild', 'Silent', 'Noble',
  'Fierce', 'Calm', 'Lucky', 'Happy', 'Sneaky', 'Fluffy', 'Tiny', 'Giant',
  'Golden', 'Silver', 'Crimson', 'Azure', 'Emerald', 'Amber', 'Violet', 'Scarlet',
  'Northern', 'Southern', 'Eastern', 'Western', 'Arctic', 'Tropical',
  'Royal', 'Cosmic', 'Electric', 'Mystic', 'Shadow', 'Storm', 'Thunder', 'Crystal',
];

class AnimalNameGenerator {
  constructor({ animals, adjectives, maxAttempts = 100, logger } = {}) {
    this.animals = animals || ANIMALS;
    this.adjectives = adjectives || ADJECTIVES;
    this.maxAttempts = maxAttempts;
    this.usedNames = new Set();
    this.logger = logger;
  }

  generate() {
    let name;
    let attempts = 0;

    do {
      const adjective = this.adjectives[Math.floor(Math.random() * this.adjectives.length)];
      const animal = this.animals[Math.floor(Math.random() * this.animals.length)];
      name = `${adjective} ${animal}`;
      attempts++;

      if (attempts >= this.maxAttempts) {
        this.logger?.debug?.('🔄 Clearing used animal names cache');
        this.usedNames.clear();
        break;
      }
    } while (this.usedNames.has(name));

    this.usedNames.add(name);
    return name;
  }

  reset() {
    this.usedNames.clear();
  }
}

module.exports = AnimalNameGenerator;
module.exports.ANIMALS = ANIMALS;
module.exports.ADJECTIVES = ADJECTIVES;
