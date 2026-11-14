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
  // The app's version, set in docker-compose.yml by nito-build.sh
  appVersion: process.env.APP_VERSION ?? "unknown",
  // DB-IP's free country database, downloaded when the image is built
  geoDatabase: process.env.GEO_DATABASE ?? "/app/geo/dbip-country-lite.mmdb",
  storeManifestUrl:
    process.env.STORE_MANIFEST_URL ??
    "https://raw.githubusercontent.com/saltedlolly/umbrel-app-store/master/saltedlolly-nito/umbrel-app.yml",
};
