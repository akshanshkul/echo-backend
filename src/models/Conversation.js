import mongoose from 'mongoose';
import { chatCache, addEvictionHooks } from '../cache.js';
const { ObjectId } = mongoose.Schema.Types;

/**
 * Each kind of chat lives in its own MongoDB collection:
 *   groups · channels · direct_chats · saved_chats
 * The rest of the code keeps using `Conversation` (find / findOne / findById / exists / countDocuments /
 * create / deleteOne): it is a thin facade that routes every call to the right collection(s).
 */
const member = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: 'User', required: true },
    role: { type: String, enum: ['owner', 'admin', 'member'], default: 'member' },
    lastRead: { type: Date, default: () => new Date(0) },
    muted: { type: Boolean, default: false },
    pinned: { type: Boolean, default: false },
    archived: { type: Boolean, default: false },
  },
  { _id: false },
);
const common = (type) => ({
  type: { type: String, enum: [type], default: type, required: true },
  members: [member],
  createdBy: { type: ObjectId, ref: 'User' },
  lastMessageAt: { type: Date, default: Date.now },
});
const build = (type, fields, collection) => {
  const schema = new mongoose.Schema({ ...common(type), ...fields }, { timestamps: true });
  schema.index({ 'members.user': 1, lastMessageAt: -1 });
  addEvictionHooks(schema, chatCache); // send-path metadata cache is dropped whenever a chat changes
  return { schema, collection };
};

// groups and channels share their "details": name, description, who can find / join, handle, invite link
const community = {
  name: { type: String, trim: true, maxlength: 60 },
  desc: { type: String, default: '', maxlength: 300 },
  // public = listed, anyone joins instantly | approval = listed, admins approve requests | private = hidden, invite link or added by an admin
  privacy: { type: String, enum: ['public', 'approval', 'private'], default: 'private' },
  handle: {
    type: String,
    lowercase: true,
    trim: true,
    unique: true,
    sparse: true,
    match: /^[a-z0-9_]{4,32}$/,
  },
  inviteCode: { type: String, unique: true, sparse: true }, // /join/<code>
  joinRequests: [
    {
      user: { type: ObjectId, ref: 'User', required: true },
      at: { type: Date, default: Date.now },
      _id: false,
    },
  ],
};
const direct = {
  dmKey: { type: String, unique: true, sparse: true },
  // message requests. A missing dmStatus means "accepted" (chats that existed before requests were introduced).
  dmStatus: { type: String, enum: ['pending', 'accepted', 'declined'] },
  requestedBy: { type: ObjectId, ref: 'User' },
  requestNote: { type: String, maxlength: 200 },
  requestedAt: { type: Date },
  respondedAt: { type: Date },
};
const saved = { name: { type: String, trim: true, maxlength: 60 } };

const defs = {
  group: build('group', community, 'groups'),
  channel: build('channel', community, 'channels'),
  dm: build('dm', direct, 'direct_chats'),
  saved: build('saved', saved, 'saved_chats'),
};
export const Group = mongoose.model('Group', defs.group.schema, 'groups');
export const Channel = mongoose.model('Channel', defs.channel.schema, 'channels');
export const DirectChat = mongoose.model('DirectChat', defs.dm.schema, 'direct_chats');
export const SavedChat = mongoose.model('SavedChat', defs.saved.schema, 'saved_chats');
export const chatModels = { group: Group, channel: Channel, dm: DirectChat, saved: SavedChat };
/** fields stored per kind (used by the data migration to drop fields that don't belong) */
export const chatFields = Object.fromEntries(
  Object.entries(chatModels).map(([k, M]) => [k, Object.keys(M.schema.paths)]),
);

/** which collections can possibly contain matches for this filter */
function targets(filter = {}) {
  let types = null;
  const t = filter.type;
  if (typeof t === 'string') types = [t];
  else if (t && Array.isArray(t.$in)) types = t.$in;
  else if (filter.dmKey || filter.requestedBy || filter.dmStatus) types = ['dm'];
  else if (filter.handle || filter.inviteCode || filter.privacy || filter.joinRequests)
    types = ['group', 'channel'];
  return (types || Object.keys(chatModels)).filter((k) => chatModels[k]).map((k) => chatModels[k]);
}
const sorter = (spec) => {
  const keys = Object.entries(
    typeof spec === 'string' ? { [spec.replace(/^-/, '')]: spec[0] === '-' ? -1 : 1 } : spec,
  );
  return (a, b) => {
    for (const [k, dir] of keys) {
      const x = a[k] instanceof Date ? +a[k] : a[k];
      const y = b[k] instanceof Date ? +b[k] : b[k];
      if (x !== y) return (x > y ? 1 : -1) * (dir < 0 ? -1 : 1);
    }
    return 0;
  };
};

/** chainable query that runs against every relevant collection and merges the results */
class MultiQuery {
  constructor(method, filter) {
    this.method = method;
    this.filter = filter;
    this.models = targets(method === 'findById' ? {} : filter);
    this.ops = [];
  }
  populate(...a) {
    this.ops.push(['populate', a]);
    return this;
  }
  select(...a) {
    this.ops.push(['select', a]);
    return this;
  }
  lean(...a) {
    this.ops.push(['lean', a]);
    return this;
  }
  sort(spec) {
    this.sortSpec = spec;
    this.ops.push(['sort', [spec]]);
    return this;
  }
  limit(n) {
    this.limitN = n;
    this.ops.push(['limit', [n]]);
    return this;
  }
  _query(M) {
    let q = M[this.method](this.filter);
    for (const [op, args] of this.ops) q = q[op](...args);
    return q;
  }
  async exec() {
    const parts = await Promise.all(this.models.map((M) => this._query(M).exec()));
    if (this.method !== 'find') return parts.find(Boolean) ?? null;
    let docs = parts.flat();
    if (this.sortSpec) docs.sort(sorter(this.sortSpec));
    if (this.limitN != null) docs = docs.slice(0, this.limitN);
    return docs;
  }
  then(res, rej) {
    return this.exec().then(res, rej);
  }
  catch(rej) {
    return this.exec().catch(rej);
  }
}

export const Conversation = {
  find: (filter = {}) => new MultiQuery('find', filter),
  findOne: (filter = {}) => new MultiQuery('findOne', filter),
  findById: (id) => new MultiQuery('findById', id),
  async exists(filter = {}) {
    const r = await Promise.all(targets(filter).map((M) => M.exists(filter)));
    return r.find(Boolean) ?? null;
  },
  async countDocuments(filter = {}) {
    const r = await Promise.all(targets(filter).map((M) => M.countDocuments(filter)));
    return r.reduce((a, b) => a + b, 0);
  },
  create(doc) {
    const M = chatModels[doc.type];
    if (!M) throw new Error('Conversation type must be dm, group, channel or saved');
    return M.create(doc);
  },
  async deleteOne(filter = {}) {
    const r = await Promise.all(targets(filter).map((M) => M.deleteOne(filter)));
    return { deletedCount: r.reduce((a, x) => a + (x.deletedCount || 0), 0) };
  },
};
