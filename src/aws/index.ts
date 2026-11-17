export * from './config';
export * from './auth';
// B1 (W13 NEXT R6): storage is NOT re-exported here on purpose. The barrel
// is imported by the boot path (App.tsx → config/auth/database), and
// re-exporting storage pulled aws-amplify/storage + the S3 client into the
// entry chunk even though only lazy screens use it. Call sites import
// storage functions directly from './storage' (see shareSend.ts).
export * from './database';
