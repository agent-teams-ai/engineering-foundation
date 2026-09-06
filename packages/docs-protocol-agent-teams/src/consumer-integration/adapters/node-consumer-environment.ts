export function consumerProcessEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env };
}
