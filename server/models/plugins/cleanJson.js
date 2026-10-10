// A small Mongoose plugin used by every model.
// When a document is sent as JSON, MongoDB's "_id" becomes a plain "id"
// and the internal "__v" version field is removed:
//   { _id: ObjectId("66f…"), __v: 0, tableNumber: 3 }  ->  { id: "66f…", tableNumber: 3 }
//
// Option: { virtuals: true } also includes calculated fields (e.g. a bill's balanceDue).

function cleanJson(schema, options = {}) {
  schema.set("toJSON", {
    versionKey: false,
    virtuals: Boolean(options.virtuals),
    transform(document, json) {
      const { _id, id, ...rest } = json; // drop Mongoose's own "id" virtual; we build ours
      return { id: String(_id), ...rest };
    },
  });
}

module.exports = cleanJson;
