import mongoose from 'mongoose';
await mongoose.connect(process.env.MONGO_URL ?? 'mongodb://localhost:27017/varuna');
const db = mongoose.connection.db!;
const u = await db.collection('users').findOne({ email: 'demo@varuna.test' });
console.log('user', u?._id?.toString(), u?.role);
const i = await db.collection('investigations').findOne({});
console.log('inv', i?._id?.toString(), 'owner', i?.ownerId?.toString(), 'members', JSON.stringify(i?.members));
await mongoose.disconnect();
