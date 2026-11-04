import mongoose from 'mongoose';
const { ObjectId } = mongoose.Schema.Types;
const attachment = new mongoose.Schema(
  {
    key: { type: String, required: true },
    name: String,
    size: Number,
    mime: String,
    kind: { type: String, enum: ['image', 'video', 'audio', 'voice', 'file'], default: 'file' },
    width: Number,
    height: Number,
    duration: Number,
  },
  { _id: false },
);
const schema = new mongoose.Schema(
  {
    conv: { type: ObjectId, ref: 'Conversation', required: true },
    sender: { type: ObjectId, ref: 'User', required: true },
    type: {
      type: String,
      enum: ['text', 'media', 'file', 'voice', 'poll', 'system'],
      default: 'text',
    },
    text: { type: String, default: '', maxlength: 30000 },
    attachments: [attachment],
    poll: {
      question: String,
      multi: Boolean,
      options: [{ text: String, votes: [{ type: ObjectId, ref: 'User' }] }],
    },
    replyTo: { type: ObjectId, ref: 'Message' },
    threadOf: { type: ObjectId, ref: 'Message', index: true },
    edited: { type: Boolean, default: false },
    deleted: { type: Boolean, default: false },
    pinned: { type: Boolean, default: false },
    starredBy: [{ type: ObjectId, ref: 'User' }],
    hiddenFor: [{ type: ObjectId, ref: 'User' }], // "delete for me": hidden only from these users
    reactions: [{ emoji: String, users: [{ type: ObjectId, ref: 'User' }], _id: false }],
  },
  { timestamps: true },
);
schema.index({ conv: 1, createdAt: -1 });
export const Message = mongoose.model('Message', schema);
