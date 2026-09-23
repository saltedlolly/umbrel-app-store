function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const config = {
  httpPort: Number(process.env.PORT ?? 3000),
  rpcHost: process.env.NITO_RPC_HOST ?? "nito",
  rpcPort: Number(process.env.NITO_RPC_PORT ?? 8825),
  rpcUser: required("NITO_RPC_USER"),
  rpcPassword: required("NITO_RPC_PASSWORD"),
};
