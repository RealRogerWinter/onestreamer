// Read a required environment variable. Throws at module load if not set.
// Use for secrets and other config that must not have hardcoded fallbacks in
// source. The error message points at .env.example so operators know where
// to look.
module.exports = function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} environment variable is required. ` +
      `Set it in your .env file (see .env.example).`
    );
  }
  return value;
};
