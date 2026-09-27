export type LocalStorageBootstrapTarget = {
  endpoint: string;
  bucket: string;
  accessKey: string;
};

export function assertLocalStorageBootstrapTarget(
  target: LocalStorageBootstrapTarget,
) {
  const endpoint = new URL(target.endpoint);
  if (
    endpoint.origin !== target.endpoint ||
    endpoint.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(endpoint.hostname) ||
    // Any explicit port: POLKA_LOCAL_S3_PORT in .env may move MinIO off 9038.
    !endpoint.port ||
    target.bucket !== "polka-local" ||
    target.accessKey !== "polka-local"
  )
    throw new Error(
      "Local storage bootstrap only supports the generated loopback target",
    );
}

export async function runLocalStorageBootstrap(
  target: LocalStorageBootstrapTarget,
  operations: {
    provision: () => Promise<void>;
    check: () => Promise<void>;
  },
) {
  assertLocalStorageBootstrapTarget(target);
  await operations.provision();
  await operations.check();
}
