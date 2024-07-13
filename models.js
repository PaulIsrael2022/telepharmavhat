const mongoose = require("mongoose");

// User Schema
const userSchema = new mongoose.Schema({
  phoneNumber: { type: String, unique: true, required: true },
  firstName: { type: String, default: null },
  surname: { type: String, default: null },
  dateOfBirth: { type: Date, default: null },
  medicalAidProvider: { type: String, default: null },
  medicalAidNumber: { type: String, default: null },
  scheme: { type: String, default: null },
  dependentNumber: { type: String, default: null },
  registrationStep: { type: Number, default: 1 },
  lastInteraction: { type: Date, default: Date.now },
  isRegistrationComplete: { type: Boolean, default: false }
}, {
  timestamps: true
});

// Prescription Schema
const prescriptionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    prescriptionPhotoUrl: String,
    prescriptionText: String,
    medicationDetails: [
      {
        name: String,
        dosage: String,
        frequency: String,
        duration: String,
      },
    ],
    status: {
      type: String,
      enum: [
        "Pending",
        "Verified",
        "Processed",
        "Ready for Pickup",
        "Out for Delivery",
        "Delivered",
        "Cancelled",
      ],
      default: "Pending",
    },
    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    notes: String,
  },
  {
    timestamps: true,
  }
);

// Service Request Schema
const serviceRequestSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    serviceType: {
      type: String,
      enum: [
        "Medication Delivery",
        "Pharmacy Consultation",
        "Doctor Consultation",
        "General Enquiry",
      ],
      required: true,
    },
    status: {
      type: String,
      enum: ["Pending", "Assigned", "In Progress", "Completed", "Cancelled"],
      default: "Pending",
    },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    notes: String,
    priority: {
      type: String,
      enum: ["Low", "Medium", "High"],
      default: "Medium",
    },
    completedAt: Date,
  },
  {
    timestamps: true,
  }
);

// Staff Schema
const staffSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    role: {
      type: String,
      enum: ["Pharmacist", "Doctor", "Admin"],
      required: true,
    },
    specialization: String,
    licenseNumber: { type: String, unique: true, required: true },
    isAvailable: { type: Boolean, default: true },
  },
  {
    timestamps: true,
  }
);

// Inventory Schema
const inventorySchema = new mongoose.Schema(
  {
    medicationName: { type: String, required: true },
    genericName: String,
    category: String,
    manufacturer: String,
    stockQuantity: { type: Number, required: true },
    unitPrice: { type: Number, required: true },
    expiryDate: Date,
    reorderLevel: Number,
  },
  {
    timestamps: true,
  }
);

// Add a pre-save hook to validate required fields only if registration is complete
userSchema.pre('save', function(next) {
  if (this.isRegistrationComplete) {
    if (!this.firstName || !this.surname || !this.dateOfBirth || !this.medicalAidProvider || !this.medicalAidNumber) {
      return next(new Error('All required fields must be filled before completing registration.'));
    }
  }
  next();
});

const User = mongoose.model("User", userSchema);
const Prescription = mongoose.model("Prescription", prescriptionSchema);
const ServiceRequest = mongoose.model("ServiceRequest", serviceRequestSchema);
const Staff = mongoose.model("Staff", staffSchema);
const Inventory = mongoose.model("Inventory", inventorySchema);

module.exports = { User, Prescription, ServiceRequest, Staff, Inventory };
