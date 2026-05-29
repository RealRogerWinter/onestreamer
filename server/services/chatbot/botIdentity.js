/**
 * Bot identity data — animal names + color palette for random viewbot/temp-bot
 * usernames, extracted verbatim from the ChatBotService constructor. Pure data.
 */

const ANIMALS = [
            'Lion', 'Tiger', 'Bear', 'Wolf', 'Fox', 'Rabbit', 'Deer', 'Eagle', 'Hawk', 'Owl',
            'Cat', 'Dog', 'Mouse', 'Rat', 'Hamster', 'Squirrel', 'Beaver', 'Otter', 'Seal', 'Whale',
            'Shark', 'Fish', 'Crab', 'Lobster', 'Shrimp', 'Octopus', 'Jellyfish', 'Starfish', 'Turtle', 'Snake',
            'Lizard', 'Frog', 'Toad', 'Salamander', 'Newt', 'Butterfly', 'Bee', 'Ant', 'Spider', 'Scorpion',
            'Penguin', 'Flamingo', 'Swan', 'Duck', 'Goose', 'Chicken', 'Turkey', 'Peacock', 'Parrot', 'Canary'
        ];

const COLORS = [
            '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD', '#98D8E8', '#F7DC6F',
            '#BB8FCE', '#85C1E9', '#F8C471', '#82E0AA', '#F1948A', '#AED6F1', '#A9DFBF', '#F9E79F',
            '#D7BDE2', '#A3E4D7', '#FAD7A0', '#D5A6BD', '#87CEEB', '#DEB887', '#F0E68C', '#FFB6C1'
        ];

module.exports = { ANIMALS, COLORS };
