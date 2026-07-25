import dotenv from 'dotenv';

/**
 * Imported for its side effect, before anything reads process.env.
 * .env.local wins over .env so a local key can override a committed default.
 */
dotenv.config({path: '.env.local'});
dotenv.config();
