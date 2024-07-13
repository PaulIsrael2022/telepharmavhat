const mongoose = require("mongoose");

// User Schema
const userSchema = new mongoose.Schema(
  {
    phoneNumber: { type: String, unique: true, required: true },
    firstName: { type: String, required: true },
    surname: { type: String, required: true },
    dateOfBirth: { type: Date, required: true },
    medicalAidProvider: { type: String, required: true },
    medicalAidNumber: { type: String, required: true },
    scheme: String,
    dependentNumber: String,
    registrationStep: { type: Number, default: 1 },
    lastInteraction: { type: Date, default: Date.now },
    preferences: {
      notificationPreference: {
        type: String,
        enum: ["SMS", "WhatsApp", "Email"],
        default: "WhatsApp",
      },
      language: { type: String, default: "English" },
    },
  },
  {
    timestamps: true,
  }
);

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

const User = mongoose.model("User", userSchema);
const Prescription = mongoose.model("Prescription", prescriptionSchema);
const ServiceRequest = mongoose.model("ServiceRequest", serviceRequestSchema);
const Staff = mongoose.model("Staff", staffSchema);
const Inventory = mongoose.model("Inventory", inventorySchema);

module.exports = { User, Prescription, ServiceRequest, Staff, Inventory };
