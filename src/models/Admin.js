import mongoose from 'mongoose';
const schema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    lastLoginAt: { type: Date },
  },
  { timestamps: true },
);
schema.methods.toPublic = function () {
  return { id: this.id, name: this.name, email: this.email, lastLoginAt: this.lastLoginAt };
};
export const Admin = mongoose.model('Admin', schema);
