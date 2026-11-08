import mongoose from "mongoose";

/**
 * Financial writes in later phases use multi-document transactions.
 * The URI must point at a replica set. See docker-compose.yml.
 */
export async function connectDatabase(uri: string): Promise<void> {
  mongoose.set("strictQuery", true);
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 5000,
  });
}

export function isDatabaseConnected(): boolean {
  return mongoose.connection.readyState === 1;
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
}
