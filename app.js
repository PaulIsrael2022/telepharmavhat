// Importing required modules
const express = require("express");
const mongoose = require("mongoose");
const axios = require("axios");
const bodyParser = require("body-parser");
const dotenv = require("dotenv");

dotenv.config();

// Schemas
const userSchema = new mongoose.Schema({
  phoneNumber: { type: String, unique: true, required: true },
  firstName: { type: String, default: null },
  surname: { type: String, default: null },
  dateOfBirth: { type: Date, default: null },
  gender: {
    type: String,
    enum: ["MALE", "FEMALE"],
    default: null,
  },
  medicalAidProvider: { type: String, default: null },
  medicalAidNumber: { type: String, default: null },
  scheme: { type: String, default: null },
  dependentNumber: { type: String, default: null },
  isRegistrationComplete: { type: Boolean, default: false },
  lastInteraction: { type: Date, default: Date.now },
  addresses: {
    home: { type: String, default: null },
    work: { type: String, default: null },
  },
  preferences: {
    notificationPreference: {
      type: String,
      enum: ["SMS", "WhatsApp", "Email"],
      default: "WhatsApp",
    },
    language: { type: String, default: "English" },
  },
  conversationState: {
    currentFlow: { type: String, default: null },
    currentStep: { type: String, default: null },
    data: {
      type: Map,
      of: mongoose.Schema.Types.Mixed,
      default: () => new Map(),
    },
    lastUpdated: { type: Date, default: Date.now },
  },
});

const orderSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    orderNumber: { type: String, unique: true, required: true },
    orderType: {
      type: String,
      enum: ["PRESCRIPTION_REFILL", "NEW_PRESCRIPTION", "OVER_THE_COUNTER"],
      required: true,
    },
    medications: [
      {
        name: { type: String, required: true },
        quantity: { type: Number, default: 1 },
        instructions: { type: String },
      },
    ],
    prescriptionImage: {
      data: Buffer,
      contentType: String,
    },
    prescriptionText: { type: String },
    forDependant: { type: Boolean, default: false },
    dependantDetails: {
      firstName: { type: String },
      lastName: { type: String },
      dateOfBirth: { type: Date },
    },
    deliveryMethod: {
      type: String,
      enum: ["DELIVERY", "PICKUP"],
      required: true,
    },
    deliveryAddress: {
      type: { type: String, enum: ["HOME", "WORK"] },
      address: { type: String },
    },
    status: {
      type: String,
      enum: [
        "PENDING",
        "PROCESSING",
        "READY_FOR_PICKUP",
        "OUT_FOR_DELIVERY",
        "DELIVERED",
        "CANCELLED",
      ],
      default: "PENDING",
    },
  },
  { timestamps: true }
);

const User = mongoose.model("User", userSchema);
const Order = mongoose.model("Order", orderSchema);

// ChatbotManager class
class ChatbotManager {
  constructor() {
    this.app = express();
    this.app.use(bodyParser.json());
    this.initializeDatabase();
    this.initializeRoutes();
    this.orderHistoryCache = new Map();
  }

  initializeDatabase() {
    mongoose
      .connect(process.env.MONGODB_URI, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
      })
      .then(() => console.log("Connected to MongoDB"))
      .catch((err) => console.error("MongoDB connection error:", err));
  }

  initializeRoutes() {
    this.app.post("/webhook", this.handleWebhook.bind(this));
    this.app.get("/webhook", this.verifyWebhook.bind(this));
  }

  async handleWebhook(req, res) {
    const { entry } = req.body;

    if (entry && entry[0].changes && entry[0].changes[0].value.messages) {
      const message = entry[0].changes[0].value.messages[0];
      const from = message.from;
      let messageBody = message.text?.body || "";

      if (message.interactive && message.interactive.button_reply) {
        messageBody = message.interactive.button_reply.title;
      }

      try {
        const user = await this.getOrCreateUser(from);
        await this.processMessage(user, messageBody);
      } catch (error) {
        console.error("Error processing webhook:", error);
        await this.sendWhatsAppMessage(
          from,
          "Sorry, we encountered an error. Please try again or contact support if the issue persists."
        );
      }
    }

    res.sendStatus(200);
  }

  verifyWebhook(req, res) {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode && token) {
      if (mode === "subscribe" && token === process.env.WEBHOOK_VERIFY_TOKEN) {
        console.log("Webhook verified");
        res.status(200).send(challenge);
      } else {
        res.sendStatus(403);
      }
    }
  }

  async getOrCreateUser(phoneNumber) {
    let user = await User.findOne({ phoneNumber });

    if (!user) {
      user = new User({
        phoneNumber,
        conversationState: {
          currentFlow: "REGISTRATION",
          currentStep: 0,
          data: new Map(),
          lastUpdated: new Date(),
        },
      });
      await user.save();
      await this.sendWelcomeMessage(user);
    } else {
      user.lastInteraction = new Date();
      await user.save();
    }

    return user;
  }

  async processMessage(user, messageBody) {
    if (!user.isRegistrationComplete) {
      await this.handleRegistration(user, messageBody);
    } else {
      await this.handleConversationRecursively(user, messageBody);
    }
  }

  async sendWhatsAppMessage(to, message, buttons = null) {
    const url = `${process.env.WHATSAPP_API_URL}/${process.env.WHATSAPP_CLOUD_API_FROM_PHONE_NUMBER_ID}/messages`;
    const headers = {
      Authorization: `Bearer ${process.env.WHATSAPP_CLOUD_API_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    };

    let data = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: to,
      type: "text",
      text: { body: message },
    };

    if (buttons) {
      data = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: to,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: message },
          action: {
            buttons: buttons.map((button, index) => ({
              type: "reply",
              reply: {
                id: `button_${index + 1}`,
                title: button,
              },
            })),
          },
        },
      };
    }

    try {
      const response = await axios.post(url, data, { headers });
      console.log("WhatsApp API Response:", response.data);
      return response.data;
    } catch (error) {
      console.error("Error sending WhatsApp message:");
      if (error.response) {
        // The request was made and the server responded with a status code
        // that falls out of the range of 2xx
        console.error("Response data:", error.response.data);
        console.error("Response status:", error.response.status);
        console.error("Response headers:", error.response.headers);
      } else if (error.request) {
        // The request was made but no response was received
        console.error("No response received:", error.request);
      } else {
        // Something happened in setting up the request that triggered an Error
        console.error("Error setting up request:", error.message);
      }
      console.error("Error config:", error.config);

      // Send a generic error message to the user
      try {
        await this.sendFallbackMessage(
          to,
          "Sorry, we encountered an error. Please try again or contact support if the issue persists."
        );
      } catch (fallbackError) {
        console.error("Failed to send fallback message:", fallbackError);
      }

      throw error; // Re-throw the error for the calling function to handle if needed
    }
  }

  async sendFallbackMessage(to, message) {
    // Implement a fallback messaging method here
    // This could be another messaging service, SMS, or even logging to a database for manual follow-up
    console.log(`Fallback message to ${to}: ${message}`);
    // For now, we'll just log it, but you might want to implement an actual fallback method
  }

  async handleRegistration(user, message) {
    const registrationSteps = [
      { prompt: "Step 1: Please provide your first name.", field: "firstName" },
      { prompt: "Step 2: Please provide your surname.", field: "surname" },
      {
        prompt:
          "Step 3: Please provide your date of birth in the format DD/MM/YYYY.",
        field: "dateOfBirth",
      },
      {
        prompt: "Step 4: Please select your gender:\n1. MALE\n2. FEMALE",
        field: "gender",
        options: ["MALE", "FEMALE"],
      },
      {
        prompt:
          "Step 5: Please select your medical aid provider. Type a number:\n1. BOMAID\n2. PULA\n3. BPOMAS\n4. BOTSOGO",
        field: "medicalAidProvider",
        options: ["BOMAID", "PULA", "BPOMAS", "BOTSOGO"],
      },
      {
        prompt: "Step 6: Please provide your medical aid number.",
        field: "medicalAidNumber",
      },
      {
        prompt: "Step 7: Please specify your scheme (if applicable).",
        field: "scheme",
      },
      {
        prompt:
          'Step 8: If you have a dependent number, please provide it. Otherwise, type "N/A".',
        field: "dependentNumber",
      },
    ];

    const currentStep = user.conversationState.currentStep;

    if (message === "00" && currentStep > 0) {
      user.conversationState.currentStep--;
      user.conversationState.data.delete(registrationSteps[currentStep].field);
      await user.save();
      await this.sendRegistrationPrompt(user, registrationSteps);
      return;
    }

    const step = registrationSteps[currentStep];
    let isValid = true;
    let parsedValue = message;

    // Input validation
    switch (step.field) {
      case "dateOfBirth":
        isValid = ChatbotManager.validateDateOfBirth(message);
        if (isValid) {
          let day, month, year;
          if (message.includes("/")) {
            [day, month, year] = message.split("/");
          } else {
            day = message.substr(0, 2);
            month = message.substr(2, 2);
            year = message.substr(4);
          }
          parsedValue = new Date(year, month - 1, day);
        }
        break;
      case "gender":
        const genderIndex = parseInt(message) - 1;
        if (genderIndex >= 0 && genderIndex < step.options.length) {
          parsedValue = step.options[genderIndex];
        } else {
          isValid = false;
        }
        break;
      case "medicalAidProvider":
        const index = parseInt(message) - 1;
        if (index >= 0 && index < step.options.length) {
          parsedValue = step.options[index];
        } else {
          isValid = false;
        }
        break;
      case "dependentNumber":
        if (message.toUpperCase() === "N/A") {
          parsedValue = null;
        }
        break;
    }

    if (!isValid) {
      await this.sendWhatsAppMessage(
        user.phoneNumber,
        "Invalid input. Please try again."
      );
      await this.sendRegistrationPrompt(user, registrationSteps);
      return;
    }

    user.conversationState.data.set(step.field, parsedValue);

    if (currentStep < registrationSteps.length - 1) {
      user.conversationState.currentStep++;
      await user.save();
      await this.sendRegistrationPrompt(user, registrationSteps);
    } else {
      // Registration complete
      for (const [field, value] of user.conversationState.data) {
        user[field] = value;
      }
      user.isRegistrationComplete = true;
      user.conversationState = {
        currentFlow: "MAIN_MENU",
        currentStep: null,
        data: new Map(),
        lastUpdated: new Date(),
      };
      await user.save();
      await this.sendCompletionMessage(user);
    }
  }

  static validateDateOfBirth(dateString) {
    const dateRegex = /^(\d{2}\/\d{2}\/\d{4}|\d{7})$/;
    if (!dateRegex.test(dateString)) {
      return false;
    }

    let day, month, year;

    if (dateString.includes("/")) {
      [day, month, year] = dateString.split("/");
    } else {
      day = dateString.substr(0, 2);
      month = dateString.substr(2, 2);
      year = dateString.substr(4);
    }

    const date = new Date(year, month - 1, day);
    return (
      !isNaN(date.getTime()) &&
      date < new Date() &&
      date.getFullYear() >= 1900 &&
      date.getFullYear() <= new Date().getFullYear()
    );
  }

  async sendRegistrationPrompt(user, registrationSteps) {
    const step = registrationSteps[user.conversationState.currentStep];
    let message = step.prompt;

    if (user.conversationState.currentStep > 0) {
      message += '\n\nEnter "00" to go back to the previous step.';
    }

    await this.sendWhatsAppMessage(user.phoneNumber, message);
  }

  async sendCompletionMessage(user) {
    const message = `Thank you for registering, ${user.firstName}! Your registration is now complete. You can now use our WhatsApp medication delivery service.`;
    await this.sendWhatsAppMessage(user.phoneNumber, message);
    await this.sendMainMenu(user);
  }

  async sendWelcomeMessage(user) {
    await this.sendWhatsAppMessage(
      user.phoneNumber,
      "Welcome to Telepharma Botswana! To start using our WhatsApp medication delivery service, you need to complete a quick registration process. This will help us serve you better. Let's begin!"
    );
    await this.sendRegistrationPrompt(user, this.registrationSteps);
  }

  async sendMainMenu(user) {
    const message = "Main Menu:";
    const buttons = ["Place an Order", "View Order Status", "More"];
    await this.sendWhatsAppMessage(user.phoneNumber, message, buttons);
  }

  async sendMoreOptions(user) {
    const message = "More Options:";
    const buttons = ["Pharmacy Consultation", "General Enquiry"];
    await this.sendWhatsAppMessage(user.phoneNumber, message, buttons);
    await this.sendWhatsAppMessage(
      user.phoneNumber,
      'Enter "00" to go back to the Main Menu.'
    );
  }

  async handleConversationRecursively(user, message, depth = 0) {
    if (depth > 10) {
      await this.sendWhatsAppMessage(
        user.phoneNumber,
        "We've encountered an issue. Returning to the main menu."
      );
      await this.resetConversationState(user);
      return;
    }

    if (ChatbotManager.isSessionTimedOut(user.conversationState.lastUpdated)) {
      await this.sendWhatsAppMessage(
        user.phoneNumber,
        "Your session has timed out. Returning to the main menu."
      );
      await this.resetConversationState(user);
      return;
    }

    switch (user.conversationState.currentFlow) {
      case "MAIN_MENU":
        await this.handleMainMenu(user, message);
        break;
      case "PLACE_ORDER":
        await this.handlePlaceOrder(user, message);
        break;
      case "VIEW_ORDER_STATUS":
        await this.handleViewOrderStatus(user, message);
        break;
      case "MEDICATION_DELIVERY":
        await this.handleMedicationDelivery(user, message);
        break;
      case "PHARMACY_CONSULTATION":
        await this.handlePharmacyConsultation(user, message);
        break;
      case "DOCTOR_CONSULTATION":
        await this.handleDoctorConsultation(user, message);
        break;
      case "GENERAL_ENQUIRY":
        await this.handleGeneralEnquiry(user, message);
        break;
      default:
        await this.resetConversationState(user);
        break;
    }

    user.lastInteraction = new Date();
    await user.save();

    // Recursive call to handle next step in conversation
    if (user.conversationState.currentFlow !== "MAIN_MENU") {
      await this.handleConversationRecursively(user, message, depth + 1);
    }
  }

  async resetConversationState(user) {
    user.conversationState = {
      currentFlow: "MAIN_MENU",
      currentStep: null,
      data: new Map(),
      lastUpdated: new Date(),
    };
    await user.save();
    await this.sendMainMenu(user);
  }

  async handleMainMenu(user, message) {
    // Check for general greetings
    const greetings = [
      "hi",
      "hello",
      "hey",
      "good morning",
      "good afternoon",
      "good evening",
    ];
    if (greetings.includes(message.toLowerCase())) {
      await this.sendWhatsAppMessage(
        user.phoneNumber,
        `Hello ${user.firstName}! How can I assist you today?`
      );
      await this.sendMainMenu(user);
      return;
    }

    switch (message) {
      case "Place an Order":
        user.conversationState = {
          currentFlow: "PLACE_ORDER",
          currentStep: "MEDICATION_TYPE",
          data: new Map(),
          lastUpdated: new Date(),
        };
        await user.save();
        await this.sendMedicationTypeOptions(user);
        break;
      case "View Order Status":
        user.conversationState = {
          currentFlow: "VIEW_ORDER_STATUS",
          currentStep: "ENTER_ORDER_NUMBER",
          data: new Map(),
          lastUpdated: new Date(),
        };
        await user.save();
        await this.sendWhatsAppMessage(
          user.phoneNumber,
          "Please enter your order number.\n\nEnter 00 to go back to the main menu."
        );
        break;
      case "More":
        await this.sendMoreOptions(user);
        break;
      case "Pharmacy Consultation":
        user.conversationState = {
          currentFlow: "PHARMACY_CONSULTATION",
          currentStep: "ENTER_ISSUE",
          data: new Map(),
          lastUpdated: new Date(),
        };
        await user.save();
        await this.sendWhatsAppMessage(
          user.phoneNumber,
          "Please describe your issue or question for the pharmacy.\n\nEnter 00 to go back to the main menu."
        );
        break;
      case "General Enquiry":
        user.conversationState = {
          currentFlow: "GENERAL_ENQUIRY",
          currentStep: "ENTER_ENQUIRY",
          data: new Map(),
          lastUpdated: new Date(),
        };
        await user.save();
        await this.sendWhatsAppMessage(
          user.phoneNumber,
          "Please enter your general enquiry.\n\nEnter 00 to go back to the main menu."
        );
        break;
      default:
        await this.sendWhatsAppMessage(
          user.phoneNumber,
          "Invalid option. Please try again."
        );
        await this.sendMainMenu(user);
    }
  }

  async handlePlaceOrder(user, message) {
    if (message === "00") {
      if (user.conversationState.currentStep === "MEDICATION_TYPE") {
        await this.resetConversationState(user);
        return;
      } else {
        // Go back to the previous step
        const steps = [
          "MEDICATION_TYPE",
          "PRESCRIPTION_OPTIONS",
          "OTC_MEDICATION_LIST",
          "DELIVERY_METHOD",
          "ENTER_WORK_ADDRESS",
          "ENTER_HOME_ADDRESS",
        ];
        const currentIndex = steps.indexOf(user.conversationState.currentStep);
        if (currentIndex > 0) {
          user.conversationState.currentStep = steps[currentIndex - 1];
          await user.save();
          await this.handlePlaceOrder(user, ""); // Resend the previous step's message
          return;
        }
      }
    }

    switch (user.conversationState.currentStep) {
      case "MEDICATION_TYPE":
        await this.handleMedicationType(user, message);
        break;
      case "PRESCRIPTION_OPTIONS":
        await this.handlePrescriptionOptions(user, message);
        break;
      case "UPLOAD_PRESCRIPTION":
        await this.handleUploadPrescription(user, message);
        break;
      case "OTC_MEDICATION_LIST":
        await this.handleOTCMedicationList(user, message);
        break;
      case "DELIVERY_METHOD":
        await this.handleDeliveryMethod(user, message);
        break;
      case "DELIVERY_ADDRESS_TYPE":
        await this.handleDeliveryAddressType(user, message);
        break;
      case "ENTER_WORK_ADDRESS":
        await this.handleEnterWorkAddress(user, message);
        break;
      case "ENTER_HOME_ADDRESS":
        await this.handleEnterHomeAddress(user, message);
        break;
      case "NEW_PRESCRIPTION_FOR":
        await this.handleNewPrescriptionFor(user, message);
        break;
      default:
        await this.sendWhatsAppMessage(
          user.phoneNumber,
          "Invalid step in order process. Returning to main menu."
        );
        await this.resetConversationState(user);
    }
  }

  async handleMedicationType(user, message) {
    if (message === "Prescription") {
      user.conversationState.currentStep = "PRESCRIPTION_OPTIONS";
      await user.save();
      await this.sendPrescriptionOptions(user);
    } else if (message === "OTC") {
      user.conversationState.data.set("orderType", "OVER_THE_COUNTER");
      user.conversationState.currentStep = "OTC_MEDICATION_LIST";
      await user.save();
      await this.sendWhatsAppMessage(
        user.phoneNumber,
        "Please enter a list of medications you would like to order.\n\nEnter 00 to go back to the previous step."
      );
    } else {
      await this.sendWhatsAppMessage(
        user.phoneNumber,
        "Invalid option. Please try again."
      );
      await this.sendMedicationTypeOptions(user);
    }
  }

  async handlePrescriptionOptions(user, message) {
    switch (message) {
      case "Prescription Refill":
        user.conversationState.currentStep = "SELECT_REFILL";
        user.conversationState.data.set("orderType", "PRESCRIPTION_REFILL");
        await user.save();
        await this.sendRefillOptions(user);
        break;
      case "New Prescription":
        user.conversationState.currentStep = "UPLOAD_PRESCRIPTION";
        user.conversationState.data.set("orderType", "NEW_PRESCRIPTION");
        await user.save();
        await this.sendWhatsAppMessage(
          user.phoneNumber,
          "Please upload a photo of your prescription or type it out.\n\nEnter 00 to go back to the previous step."
        );
        break;
      case "0":
        await this.resetConversationState(user);
        break;
      default:
        await this.sendWhatsAppMessage(
          user.phoneNumber,
          "Invalid option. Please try again."
        );
        await this.sendPrescriptionOptions(user);
    }
  }

  async handleUploadPrescription(user, message) {
    if (message.type === "image") {
      try {
        const response = await axios.get(message.image.url, {
          responseType: "arraybuffer",
        });
        const imageBuffer = Buffer.from(response.data, "binary");

        user.conversationState.data.set("prescriptionImage", {
          data: imageBuffer,
          contentType: response.headers["content-type"],
        });

        user.conversationState.currentStep = "NEW_PRESCRIPTION_FOR";
        await user.save();
        await this.sendWhatsAppMessage(
          user.phoneNumber,
          "Prescription image received. Thank you."
        );
        await this.sendNewPrescriptionOptions(user);
      } catch (error) {
        console.error("Error downloading prescription image:", error);
        await this.sendWhatsAppMessage(
          user.phoneNumber,
          "We encountered an error processing your prescription image. Please try uploading it again."
        );
      }
    } else {
      user.conversationState.data.set("prescriptionText", message);
      user.conversationState.currentStep = "NEW_PRESCRIPTION_FOR";
      await user.save();
      await this.sendWhatsAppMessage(
        user.phoneNumber,
        "Prescription text received. Thank you."
      );
      await this.sendNewPrescriptionOptions(user);
    }
  }

  async handleOTCMedicationList(user, message) {
    user.conversationState.data.set("medications", message);
    user.conversationState.currentStep = "DELIVERY_METHOD";
    await user.save();
    await this.sendDeliveryOptions(user);
  }

  async handleDeliveryMethod(user, message) {
    switch (message) {
      case "Delivery":
        user.conversationState.currentStep = "DELIVERY_ADDRESS_TYPE";
        user.conversationState.data.set("deliveryMethod", "DELIVERY");
        await user.save();
        await this.sendDeliveryAddressOptions(user);
        break;
      case "Pickup":
        user.conversationState.data.set("deliveryMethod", "PICKUP");
        await this.finishOrder(user);
        break;
      case "0":
        await this.resetConversationState(user);
        break;
      default:
        await this.sendWhatsAppMessage(
          user.phoneNumber,
          "Invalid option. Please try again."
        );
        await this.sendDeliveryOptions(user);
    }
  }

  async handleDeliveryAddressType(user, message) {
    switch (message) {
      case "Work":
        user.conversationState.currentStep = "ENTER_WORK_ADDRESS";
        await user.save();
        await this.sendWhatsAppMessage(
          user.phoneNumber,
          "Please enter your work name and physical address.\n\nEnter 00 to go back to the previous step."
        );
        break;
      case "Home":
        user.conversationState.currentStep = "ENTER_HOME_ADDRESS";
        await user.save();
        await this.sendWhatsAppMessage(
          user.phoneNumber,
          "Please enter your home address.\n\nEnter 00 to go back to the previous step."
        );
        break;
      default:
        await this.sendWhatsAppMessage(
          user.phoneNumber,
          "Invalid option. Please try again."
        );
        await this.sendDeliveryAddressOptions(user);
    }
  }

  async handleEnterWorkAddress(user, message) {
    user.conversationState.data.set("workAddress", message);
    await this.finishOrder(user);
  }

  async handleEnterHomeAddress(user, message) {
    user.conversationState.data.set("homeAddress", message);
    await this.finishOrder(user);
  }

  async handleNewPrescriptionFor(user, message) {
    if (message === "Principal Member" || message === "Dependant") {
      user.conversationState.data.set("prescriptionFor", message);
      user.conversationState.currentStep = "DELIVERY_METHOD";
      await user.save();
      await this.sendDeliveryOptions(user);
    } else {
      await this.sendWhatsAppMessage(
        user.phoneNumber,
        "Invalid option. Please try again."
      );
      await this.sendNewPrescriptionOptions(user);
    }
  }

  async finishOrder(user) {
    const orderData = {
      user: user._id,
      orderNumber: ChatbotManager.generateOrderNumber(),
      orderType:
        user.conversationState.data.get("orderType") || "OVER_THE_COUNTER",
      medications: user.conversationState.data.get("medications")
        ? [{ name: user.conversationState.data.get("medications") }]
        : [{ name: "To be specified" }],
      deliveryMethod: user.conversationState.data.get("deliveryMethod"),
      deliveryAddress: {
        type: user.conversationState.data.get("workAddress") ? "WORK" : "HOME",
        address:
          user.conversationState.data.get("workAddress") ||
          user.conversationState.data.get("homeAddress"),
      },
      status: "PENDING",
    };

    const prescriptionImage =
      user.conversationState.data.get("prescriptionImage");
    if (prescriptionImage && prescriptionImage.data) {
      orderData.prescriptionImage = {
        data: prescriptionImage.data,
        contentType: prescriptionImage.contentType,
      };
    }

    const prescriptionText =
      user.conversationState.data.get("prescriptionText");
    if (prescriptionText) {
      orderData.prescriptionText = prescriptionText;
    }

    const order = new Order(orderData);

    try {
      await order.save();

      let message;
      if (
        order.orderType === "NEW_PRESCRIPTION" ||
        order.orderType === "PRESCRIPTION_REFILL"
      ) {
        message = `Thank you for providing your prescription, ${user.firstName}. Your order number is ${order.orderNumber}. We'll process your request, and a pharmacist will review it. Your medication will be delivered soon.`;
      } else if (order.deliveryMethod === "DELIVERY") {
        message = `Thank you for your order, ${user.firstName}! Your order number is ${order.orderNumber}. Your medication will be delivered soon.`;
      } else {
        message = `Thank you for your order, ${user.firstName}! Your order number is ${order.orderNumber}. Your medication will be ready for pickup soon.`;
      }

      await this.sendWhatsAppMessage(user.phoneNumber, message);
      await this.resetConversationState(user);
    } catch (error) {
      console.error("Error saving order:", error);
      await this.sendWhatsAppMessage(
        user.phoneNumber,
        "We encountered an error processing your order. Please try again or contact support."
      );
      await this.resetConversationState(user);
    }
  }

  async handleViewOrderStatus(user, message) {
    if (message === "00") {
      await this.resetConversationState(user);
      return;
    }

    try {
      const order = await Order.findOne({
        orderNumber: message,
        user: user._id,
      });
      if (order) {
        const statusMessage = `Your order status for order number ${order.orderNumber} is: ${order.status}`;
        await this.sendWhatsAppMessage(user.phoneNumber, statusMessage);
      } else {
        await this.sendWhatsAppMessage(
          user.phoneNumber,
          "Order not found. Please check the order number and try again."
        );
      }
    } catch (error) {
      console.error("Error fetching order status:", error);
      await this.sendWhatsAppMessage(
        user.phoneNumber,
        "We encountered an error fetching your order status. Please try again later."
      );
    }

    await this.sendWhatsAppMessage(
      user.phoneNumber,
      "Enter another order number or '00' to go back to the main menu."
    );
  }

  async handleMedicationDelivery(user, message) {
    if (message === "00") {
      await this.resetConversationState(user);
      return;
    }

    user.addresses.home = message;
    await user.save();

    await this.sendWhatsAppMessage(
      user.phoneNumber,
      `Your default delivery address has been updated to: ${message}`
    );
    await this.resetConversationState(user);
  }

  async handlePharmacyConsultation(user, message) {
    if (message === "00") {
      await this.resetConversationState(user);
      return;
    }

    // In a real-world scenario, you would save this consultation request and notify a pharmacist
    await this.sendWhatsAppMessage(
      user.phoneNumber,
      "Thank you for your inquiry. A pharmacist will get back to you shortly."
    );
    await this.resetConversationState(user);
  }

  async handleDoctorConsultation(user, message) {
    if (message === "00") {
      await this.resetConversationState(user);
      return;
    }

    // In a real-world scenario, you would save this consultation request and notify a doctor
    await this.sendWhatsAppMessage(
      user.phoneNumber,
      "Thank you for your inquiry. A doctor will get back to you shortly."
    );
    await this.resetConversationState(user);
  }

  async handleGeneralEnquiry(user, message) {
    if (message === "00") {
      await this.resetConversationState(user);
      return;
    }

    // In a real-world scenario, you would save this enquiry and notify customer support
    await this.sendWhatsAppMessage(
      user.phoneNumber,
      "Thank you for your enquiry. Our customer support team will get back to you as soon as possible."
    );
    await this.resetConversationState(user);
  }

  async sendMedicationTypeOptions(user) {
    const message = "Medication Details:";
    const buttons = ["Prescription", "OTC"];
    await this.sendWhatsAppMessage(user.phoneNumber, message, buttons);
    await this.sendWhatsAppMessage(
      user.phoneNumber,
      "Prescription: For prescribed medications\nOTC: For over-the-counter medications\n\nEnter 00 to go back to the main menu."
    );
  }

  async sendPrescriptionOptions(user) {
    const message = "Prescription Options:";
    const buttons = ["Prescription Refill", "New Prescription"];
    await this.sendWhatsAppMessage(user.phoneNumber, message, buttons);
    await this.sendWhatsAppMessage(
      user.phoneNumber,
      "Enter 0 to go back to Main Menu\nEnter 00 to go back to the previous step."
    );
  }

  async sendRefillOptions(user) {
    const recentOrders = await this.getUserOrderHistory(user._id);
    let message = "Select Your Refill:";
    recentOrders.forEach((order, index) => {
      message += `\n${index + 1}. Order ${order.orderNumber} (${
        order.medications[0].name
      })`;
    });
    message += "\n\nEnter 00 to go back to the previous step.";
    await this.sendWhatsAppMessage(user.phoneNumber, message);
  }

  async sendNewPrescriptionOptions(user) {
    const message = "Who is the prescription for?";
    const buttons = ["Principal Member", "Dependant"];
    await this.sendWhatsAppMessage(user.phoneNumber, message, buttons);
    await this.sendWhatsAppMessage(
      user.phoneNumber,
      "Enter 00 to go back to the previous step."
    );
  }

  async sendDeliveryOptions(user) {
    const message =
      "Would you like the medication to be delivered, or will you be picking it up?";
    const buttons = ["Delivery", "Pickup"];
    await this.sendWhatsAppMessage(user.phoneNumber, message, buttons);
    await this.sendWhatsAppMessage(
      user.phoneNumber,
      "Enter 0 to go back to Main Menu\nEnter 00 to go back to the previous step."
    );
  }

  async sendDeliveryAddressOptions(user) {
    const message = "Where do you want your medication to be delivered?";
    const buttons = ["Work", "Home"];
    await this.sendWhatsAppMessage(user.phoneNumber, message, buttons);
    await this.sendWhatsAppMessage(
      user.phoneNumber,
      "Enter 00 to go back to the previous step."
    );
  }

  // Dynamic Programming: Implement memoization for frequently accessed data
  async getUserOrderHistory(userId) {
    if (!this.orderHistoryCache.has(userId)) {
      const orders = await Order.find({ user: userId })
        .sort({ createdAt: -1 })
        .limit(5);
      this.orderHistoryCache.set(userId, orders);

      // Set a timeout to clear the cache after 5 minutes
      setTimeout(() => {
        this.orderHistoryCache.delete(userId);
      }, 5 * 60 * 1000);
    }

    return this.orderHistoryCache.get(userId);
  }

  // Functional Programming: Use pure functions for specific tasks
  static generateOrderNumber() {
    return `ORD-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  }

  static isSessionTimedOut(lastUpdated) {
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
    return lastUpdated < thirtyMinutesAgo;
  }

  // Periodic cleanup function
  async cleanupStaleConversationStates() {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    try {
      await User.updateMany(
        { "conversationState.lastUpdated": { $lt: oneHourAgo } },
        {
          $set: {
            "conversationState.currentFlow": "MAIN_MENU",
            "conversationState.currentStep": null,
            "conversationState.data": {},
            "conversationState.lastUpdated": new Date(),
          },
        }
      );
      console.log("Cleaned up stale conversation states");
    } catch (error) {
      console.error("Error cleaning up stale conversation states:", error);
    }
  }

  start(port) {
    this.app.listen(port, () => console.log(`Server running on port ${port}`));

    // Run cleanup every hour
    setInterval(() => this.cleanupStaleConversationStates(), 60 * 60 * 1000);
  }
}

// Create and start the chatbot
const chatbot = new ChatbotManager();
chatbot.start(process.env.PORT || 3000);
