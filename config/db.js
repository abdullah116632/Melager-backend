import mongoose from 'mongoose';
import dns from 'node:dns';

const DEFAULT_DNS_SERVERS = ['8.8.8.8', '1.1.1.1'];

const applyMongoSrvDnsWorkaround = (mongoUri) => {
  if (!mongoUri || !mongoUri.startsWith('mongodb+srv://')) return;

  const configuredServers = (process.env.MONGO_DNS_SERVERS || '')
    .split(',')
    .map((server) => server.trim())
    .filter(Boolean);

  const dnsServers = configuredServers.length > 0 ? configuredServers : DEFAULT_DNS_SERVERS;
  dns.setServers(dnsServers);
  console.log(`[MongoDB] DNS servers: ${dnsServers.join(', ')}`);
};

const connectDB = async () => {
  try {
    const mongoUri = process.env.MONGO_URI;
    applyMongoSrvDnsWorkaround(mongoUri);

    const conn = await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 15000,
      family: 4,
    });

    console.log(`MongoDB connected: ${conn.connection.host}`);
  } catch (error) {
    console.error(`MongoDB connection error: ${error.message}`);

    if (error.message.includes('querySrv')) {
      console.error('MongoDB SRV lookup failed. Verify DNS or set MONGO_DNS_SERVERS=8.8.8.8,1.1.1.1 in .env');
    }

    process.exit(1);
  }
};

export default connectDB;
