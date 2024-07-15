const express = require("express");
const mongoose = require("mongoose");
const axios = require("axios");
const bodyParser = require("body-parser");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
app.use(bodyParser.json());

// User Schema
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

const User = mongoose.model("User", userSchema);

// Order Schema
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
    prescriptionText: { type: String }, // URL to stored image
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

const Order = mongoose.model("Order", orderSchema);

// Connect to MongoDB
mongoose
  .connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log("Connected to MongoDB"))
  .catch((err) => console.error("MongoDB connection error:", err));

// WhatsApp Cloud API Configuration
const WHATSAPP_API_URL = "https://graph.facebook.com/v18.0";
const PHONE_NUMBER_ID = process.env.WHATSAPP_CLOUD_API_FROM_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.WHATSAPP_CLOUD_API_ACCESS_TOKEN;

// Helper function to send WhatsApp messages
async function sendWhatsAppMessage(to, message, buttons = null) {
  const url = `${WHATSAPP_API_URL}/${PHONE_NUMBER_ID}/messages`;
  const headers = {
    Authorization: `Bearer ${ACCESS_TOKEN}`,
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
    await axios.post(url, data, { headers });
  } catch (error) {
    console.error(
      "Error sending WhatsApp message:",
      error.response?.data || error.message
    );
    // Send a generic error message to the user
    await sendWhatsAppMessage(
      to,
      "Sorry, we encountered an error. Please try again or contact support if the issue persists."
    );
  }
}

// Registration steps
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

async function sendRegistrationPrompt(user) {
  const step = registrationSteps[user.conversationState.currentStep];
  let message = step.prompt;

  if (user.conversationState.currentStep > 0) {
    message += '\n\nEnter "00" to go back to the previous step.';
  }

  await sendWhatsAppMessage(user.phoneNumber, message);
}

async function handleRegistration(user, message) {
  try {
    if (message === "00" && user.conversationState.currentStep > 0) {
      user.conversationState.currentStep--;
      user.conversationState.data.delete(
        registrationSteps[user.conversationState.currentStep].field
      );
      await user.save();
      await sendRegistrationPrompt(user);
      return;
    }

    const step = registrationSteps[user.conversationState.currentStep];
    let isValid = true;
    let parsedValue = message;

    // Input validation
    switch (step.field) {
      case "dateOfBirth":
        const dateRegex = /^\d{2}\/\d{2}\/\d{4}$/;
        if (!dateRegex.test(message)) {
          isValid = false;
        } else {
          const [day, month, year] = message.split("/");
          parsedValue = new Date(year, month - 1, day);
          if (isNaN(parsedValue.getTime()) || parsedValue >= new Date()) {
            isValid = false;
          }
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
      await sendWhatsAppMessage(
        user.phoneNumber,
        "Invalid input. Please try again."
      );
      await sendRegistrationPrompt(user);
      return;
    }

    user.conversationState.data.set(step.field, parsedValue);

    if (user.conversationState.currentStep < registrationSteps.length - 1) {
      user.conversationState.currentStep++;
      await user.save();
      await sendRegistrationPrompt(user);
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
      await sendCompletionMessage(user);
    }
  } catch (error) {
    console.error("Error in handleRegistration:", error);
    await sendWhatsAppMessage(
      user.phoneNumber,
      "We encountered an error processing your registration. Please try again or contact support if the issue persists."
    );
  }
}

async function sendCompletionMessage(user) {
  const message = `Thank you for registering, ${user.firstName}! Your registration is now complete. You can now use our WhatsApp medication delivery service.`;
  await sendWhatsAppMessage(user.phoneNumber, message);
  await sendMainMenu(user);
}

async function sendWelcomeMessage(user) {
  await sendWhatsAppMessage(
    user.phoneNumber,
    "Welcome to Telepharma Botswana! To start using our WhatsApp medication delivery service, you need to complete a quick registration process. This will help us serve you better. Let's begin!"
  );
  await sendRegistrationPrompt(user);
}

async function sendMainMenu(user) {
  const message =
    "Main Menu:\n1. Place an Order\n2. View Order Status\n3. Medication Delivery\n4. Pharmacy Consultation\n5. Doctor Consultation\n6. General Enquiry";
  await sendWhatsAppMessage(user.phoneNumber, message);
}

async function handleMainMenu(user, message) {
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
    await sendWhatsAppMessage(
      user.phoneNumber,
      `Hello ${user.firstName}! How can I assist you today?`
    );
    await sendMainMenu(user);
    return;
  }

  switch (message) {
    case "1":
      user.conversationState = {
        currentFlow: "PLACE_ORDER",
        currentStep: "MEDICATION_TYPE",
        data: new Map(),
        lastUpdated: new Date(),
      };
      await user.save();
      await sendMedicationTypeOptions(user);
      break;
    case "2":
      user.conversationState = {
        currentFlow: "VIEW_ORDER_STATUS",
        currentStep: "ENTER_ORDER_NUMBER",
        data: new Map(),
        lastUpdated: new Date(),
      };
      await user.save();
      await sendWhatsAppMessage(
        user.phoneNumber,
        "Please enter your order number.\n\nEnter 00 to go back to the main menu."
      );
      break;
    case "3":
      user.conversationState = {
        currentFlow: "MEDICATION_DELIVERY",
        currentStep: "ENTER_ADDRESS",
        data: new Map(),
        lastUpdated: new Date(),
      };
      await user.save();
      await sendWhatsAppMessage(
        user.phoneNumber,
        "Please enter your delivery address.\n\nEnter 00 to go back to the main menu."
      );
      break;
    case "4":
      user.conversationState = {
        currentFlow: "PHARMACY_CONSULTATION",
        currentStep: "ENTER_ISSUE",
        data: new Map(),
        lastUpdated: new Date(),
      };
      await user.save();
      await sendWhatsAppMessage(
        user.phoneNumber,
        "Please describe your issue or question for the pharmacy.\n\nEnter 00 to go back to the main menu."
      );
      break;
    case "5":
      user.conversationState = {
        currentFlow: "DOCTOR_CONSULTATION",
        currentStep: "ENTER_ISSUE",
        data: new Map(),
        lastUpdated: new Date(),
      };
      await user.save();
      await sendWhatsAppMessage(
        user.phoneNumber,
        "Please describe your issue or question for the doctor.\n\nEnter 00 to go back to the main menu."
      );
      break;
    case "6":
      user.conversationState = {
        currentFlow: "GENERAL_ENQUIRY",
        currentStep: "ENTER_ENQUIRY",
        data: new Map(),
        lastUpdated: new Date(),
      };
      await user.save();
      await sendWhatsAppMessage(
        user.phoneNumber,
        "Please enter your general enquiry.\n\nEnter 00 to go back to the main menu."
      );
      break;
    default:
      await sendWhatsAppMessage(
        user.phoneNumber,
        "Invalid option. Please try again."
      );
      await sendMainMenu(user);
  }
}

async function sendMedicationTypeOptions(user) {
  const message = "Medication Details:";
  //   const buttons = ["Prescription Medicine", "Over-the-Counter"];
  const buttons = ["Prescription", "OTC"];
  await sendWhatsAppMessage(user.phoneNumber, message, buttons);
  await sendWhatsAppMessage(
    user.phoneNumber,
    "Prescription: For prescribed medications\nOTC: For over-the-counter medications\n\nEnter 00 to go back to the main menu."
  );
}

async function handlePlaceOrder(user, message) {
  if (message === "00") {
    if (user.conversationState.currentStep === "MEDICATION_TYPE") {
      user.conversationState = {
        currentFlow: "MAIN_MENU",
        currentStep: null,
        data: new Map(),
        lastUpdated: new Date(),
      };
      await user.save();
      await sendMainMenu(user);
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
        await handlePlaceOrder(user, ""); // Resend the previous step's message
        return;
      }
    }
  }

  switch (user.conversationState.currentStep) {
    case "MEDICATION_TYPE":
      if (message === "Prescription") {
        user.conversationState.currentStep = "PRESCRIPTION_OPTIONS";
        await user.save();
        await sendPrescriptionOptions(user);
      } else if (message === "OTC") {
        // ADD: Set the orderType for OTC orders
        user.conversationState.data.set("orderType", "OVER_THE_COUNTER");
        user.conversationState.currentStep = "OTC_MEDICATION_LIST";
        await user.save();
        await sendWhatsAppMessage(
          user.phoneNumber,
          "Please enter a list of medications you would like to order.\n\nEnter 00 to go back to the previous step."
        );
      } else {
        await sendWhatsAppMessage(
          user.phoneNumber,
          "Invalid option. Please try again."
        );
        await sendMedicationTypeOptions(user);
      }
      break;
    case "PRESCRIPTION_OPTIONS":
      await handlePrescriptionOptions(user, message);
      break;
    case "UPLOAD_PRESCRIPTION":
      if (message.type === "image") {
        try {
          // Download the image
          const response = await axios.get(message.image.url, {
            responseType: "arraybuffer",
          });
          const imageBuffer = Buffer.from(response.data, "binary");

          // Store the image data in the conversation state
          user.conversationState.data.set("prescriptionImage", {
            data: imageBuffer,
            contentType: response.headers["content-type"],
          });

          user.conversationState.currentStep = "NEW_PRESCRIPTION_FOR";
          await user.save();
          await sendNewPrescriptionOptions(user);
        } catch (error) {
          console.error("Error downloading prescription image:", error);
          await sendWhatsAppMessage(
            user.phoneNumber,
            "We encountered an error processing your prescription image. Please try uploading it again."
          );
        }
      } else {
        // If it's text, treat it as typed prescription
        user.conversationState.data.set("prescriptionText", message);
        user.conversationState.currentStep = "NEW_PRESCRIPTION_FOR";
        await user.save();
        await sendNewPrescriptionOptions(user);
      }
      break;
    case "OTC_MEDICATION_LIST":
      // ADD: Set the medications in the conversation state
      user.conversationState.data.set("medications", message);
      user.conversationState.currentStep = "DELIVERY_METHOD";
      await user.save();
      await sendDeliveryOptions(user);
      break;
    case "DELIVERY_METHOD":
      await handleDeliveryMethod(user, message);
      break;
    // ADD: New case for DELIVERY_ADDRESS_TYPE
    case "DELIVERY_ADDRESS_TYPE":
      await handleDeliveryAddressType(user, message);
      break;
    case "ENTER_WORK_ADDRESS":
      user.conversationState.data.set("workAddress", message);
      await finishOrder(user);
      break;
    case "ENTER_HOME_ADDRESS":
      user.conversationState.data.set("homeAddress", message);
      await finishOrder(user);
      break;
    case "NEW_PRESCRIPTION_FOR":
      if (message === "Principal Member" || message === "Dependant") {
        user.conversationState.data.set("prescriptionFor", message);
        user.conversationState.currentStep = "DELIVERY_METHOD";
        await user.save();
        await sendDeliveryOptions(user);
      } else {
        await sendWhatsAppMessage(
          user.phoneNumber,
          "Invalid option. Please try again."
        );
        await sendNewPrescriptionOptions(user);
      }
      break;
    default:
      await sendWhatsAppMessage(
        user.phoneNumber,
        "Invalid step in order process. Returning to main menu."
      );
      user.conversationState = {
        currentFlow: "MAIN_MENU",
        currentStep: null,
        data: new Map(),
        lastUpdated: new Date(),
      };
      await user.save();
      await sendMainMenu(user);
  }
}

async function sendPrescriptionOptions(user) {
  const message = "Prescription Options:";
  const buttons = ["Prescription Refill", "New Prescription"];
  await sendWhatsAppMessage(user.phoneNumber, message, buttons);
  await sendWhatsAppMessage(
    user.phoneNumber,
    "Enter 0 to go back to Main Menu\nEnter 00 to go back to the previous step."
  );
}

async function handlePrescriptionOptions(user, message) {
  switch (message) {
    case "Prescription Refill":
      user.conversationState.currentStep = "SELECT_REFILL";
      user.conversationState.data.set("orderType", "PRESCRIPTION_REFILL");
      await user.save();
      await sendRefillOptions(user);
      break;
    case "New Prescription":
      user.conversationState.currentStep = "UPLOAD_PRESCRIPTION";
      user.conversationState.data.set("orderType", "NEW_PRESCRIPTION");
      await user.save();
      await sendWhatsAppMessage(
        user.phoneNumber,
        "Please upload a photo of your prescription or type it out."
      );
    case "0":
      user.conversationState = {
        currentFlow: "MAIN_MENU",
        currentStep: null,
        data: new Map(),
        lastUpdated: new Date(),
      };
      await user.save();
      await sendMainMenu(user);
      break;
    default:
      await sendWhatsAppMessage(
        user.phoneNumber,
        "Invalid option. Please try again."
      );
      await sendPrescriptionOptions(user);
  }
}

async function sendRefillOptions(user) {
  // In a real-world scenario, you would fetch the user's last three orders from the database
  // For this example, we'll use placeholder data
  const message =
    "Select Your Refill:\n1. Medication A\n2. Medication B\n3. Medication C\n\nEnter 00 to go back to the previous step.";
  await sendWhatsAppMessage(user.phoneNumber, message);
}

async function sendNewPrescriptionOptions(user) {
  const message = "Who is the prescription for?";
  const buttons = ["Principal Member", "Dependant"];
  await sendWhatsAppMessage(user.phoneNumber, message, buttons);
  await sendWhatsAppMessage(
    user.phoneNumber,
    "Enter 00 to go back to the previous step."
  );
}

async function sendDeliveryOptions(user) {
  const message =
    "Would you like the medication to be delivered, or will you be picking it up?";
  const buttons = ["Delivery", "Pickup"];
  await sendWhatsAppMessage(user.phoneNumber, message, buttons);
  await sendWhatsAppMessage(
    user.phoneNumber,
    "Enter 0 to go back to Main Menu\nEnter 00 to go back to the previous step."
  );
}

async function handleDeliveryMethod(user, message) {
  switch (message) {
    case "Delivery":
      user.conversationState.currentStep = "DELIVERY_ADDRESS_TYPE";
      user.conversationState.data.set("deliveryMethod", "DELIVERY");
      await user.save();
      await sendDeliveryAddressOptions(user);
      break;
    case "Pickup":
      user.conversationState.data.set("deliveryMethod", "PICKUP");
      await finishOrder(user);
      break;
    case "0":
      user.conversationState = {
        currentFlow: "MAIN_MENU",
        currentStep: null,
        data: new Map(),
        lastUpdated: new Date(),
      };
      await user.save();
      await sendMainMenu(user);
      break;
    default:
      await sendWhatsAppMessage(
        user.phoneNumber,
        "Invalid option. Please try again."
      );
      await sendDeliveryOptions(user);
  }
}

async function sendDeliveryAddressOptions(user) {
  const message = "Where do you want your medication to be delivered?";
  const buttons = ["Work", "Home"];
  await sendWhatsAppMessage(user.phoneNumber, message, buttons);
  await sendWhatsAppMessage(
    user.phoneNumber,
    "Enter 00 to go back to the previous step."
  );
}

async function handleDeliveryAddressType(user, message) {
  switch (message) {
    case "Work":
      user.conversationState.currentStep = "ENTER_WORK_ADDRESS";
      await user.save();
      await sendWhatsAppMessage(
        user.phoneNumber,
        "Please enter your work name and physical address.\n\nEnter 00 to go back to the previous step."
      );
      break;
    case "Home":
      user.conversationState.currentStep = "ENTER_HOME_ADDRESS";
      await user.save();
      await sendWhatsAppMessage(
        user.phoneNumber,
        "Please enter your home address.\n\nEnter 00 to go back to the previous step."
      );
      break;
    default:
      await sendWhatsAppMessage(
        user.phoneNumber,
        "Invalid option. Please try again."
      );
      await sendDeliveryAddressOptions(user);
  }
}

async function finishOrder(user) {
  // Create a new order in the database
  const order = new Order({
    user: user._id,
    orderNumber: generateOrderNumber(),
    // EDIT: Ensure orderType is always set
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
  });

  // ADD: Include prescription image or text
  const prescriptionImage =
    user.conversationState.data.get("prescriptionImage");
  if (prescriptionImage) {
    orderData.prescriptionImage = prescriptionImage;
  }

  const prescriptionText = user.conversationState.data.get("prescriptionText");
  if (prescriptionText) {
    orderData.prescriptionText = prescriptionText;
  }

  await order.save();

  let message;
  if (
    order.orderType === "NEW_PRESCRIPTION" ||
    order.orderType === "PRESCRIPTION_REFILL"
  ) {
    message = `Thank you for providing your prescription, ${user.firstName}. We'll process your request, and a pharmacist will review it. Your medication will be delivered soon.`;
  } else if (order.deliveryMethod === "DELIVERY") {
    message = `Thank you for your order, ${user.firstName}! Your medication will be delivered soon.`;
  } else {
    message = `Thank you for your order, ${user.firstName}! Your medication will be ready for pickup soon.`;
  }

  await sendWhatsAppMessage(user.phoneNumber, message);

  // Reset conversation state
  user.conversationState = {
    currentFlow: "MAIN_MENU",
    currentStep: null,
    data: new Map(),
    lastUpdated: new Date(),
  };
  await user.save();

  await sendMainMenu(user);
}

function generateOrderNumber() {
  // Generate a unique order number (you might want to implement a more robust system)
  return "ORD-" + Date.now();
}

async function handleConversation(user, message) {
  // Check if there's an active conversation flow
  if (
    !user.conversationState.currentFlow ||
    user.conversationState.currentFlow === "MAIN_MENU"
  ) {
    user.conversationState = {
      currentFlow: "MAIN_MENU",
      currentStep: null,
      data: new Map(),
      lastUpdated: new Date(),
    };
    await user.save();
    await handleMainMenu(user, message);
    return;
  }

  // Check for session timeout (30 minutes)
  const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
  if (user.conversationState.lastUpdated < thirtyMinutesAgo) {
    await sendWhatsAppMessage(
      user.phoneNumber,
      "Your session has timed out. Returning to the main menu."
    );
    user.conversationState = {
      currentFlow: "MAIN_MENU",
      currentStep: null,
      data: new Map(),
      lastUpdated: new Date(),
    };
    await user.save();
    await sendMainMenu(user);
    return;
  }

  switch (user.conversationState.currentFlow) {
    case "REGISTRATION":
      await handleRegistration(user, message);
      break;
    case "PLACE_ORDER":
      await handlePlaceOrder(user, message);
      break;
    case "VIEW_ORDER_STATUS":
      await handleViewOrderStatus(user, message);
      break;
    case "MEDICATION_DELIVERY":
      await handleMedicationDelivery(user, message);
      break;
    case "PHARMACY_CONSULTATION":
      await handlePharmacyConsultation(user, message);
      break;
    case "DOCTOR_CONSULTATION":
      await handleDoctorConsultation(user, message);
      break;
    case "GENERAL_ENQUIRY":
      await handleGeneralEnquiry(user, message);
      break;
    default:
      console.error(
        `Unknown conversation flow: ${user.conversationState.currentFlow}`
      );
      await sendWhatsAppMessage(
        user.phoneNumber,
        "I'm sorry, I didn't understand that. Let's go back to the main menu."
      );
      user.conversationState = {
        currentFlow: "MAIN_MENU",
        currentStep: null,
        data: new Map(),
        lastUpdated: new Date(),
      };
      await user.save();
      await sendMainMenu(user);
  }

  // Update the last interaction time
  user.lastInteraction = new Date();
  await user.save();
}

async function handleViewOrderStatus(user, message) {
  if (message === "00") {
    user.conversationState = {
      currentFlow: "MAIN_MENU",
      currentStep: null,
      data: new Map(),
      lastUpdated: new Date(),
    };
    await user.save();
    await sendMainMenu(user);
    return;
  }

  // In a real-world scenario, you would fetch the order status from the database
  // For this example, we'll use a placeholder response
  await sendWhatsAppMessage(
    user.phoneNumber,
    `Your order status for order number ${message} is: Processing\n\nEnter 00 to go back to the main menu.`
  );
}

async function handleMedicationDelivery(user, message) {
  if (message === "00") {
    user.conversationState = {
      currentFlow: "MAIN_MENU",
      currentStep: null,
      data: new Map(),
      lastUpdated: new Date(),
    };
    await user.save();
    await sendMainMenu(user);
    return;
  }

  await sendWhatsAppMessage(
    user.phoneNumber,
    `Your medication will be delivered to ${message}.\n\nEnter 00 to go back to the main menu.`
  );
}

async function handlePharmacyConsultation(user, message) {
  if (message === "00") {
    user.conversationState = {
      currentFlow: "MAIN_MENU",
      currentStep: null,
      data: new Map(),
      lastUpdated: new Date(),
    };
    await user.save();
    await sendMainMenu(user);
    return;
  }

  await sendWhatsAppMessage(
    user.phoneNumber,
    "Thank you. A pharmacy consultant will get back to you shortly.\n\nEnter 00 to go back to the main menu."
  );
}

async function handleDoctorConsultation(user, message) {
  if (message === "00") {
    user.conversationState = {
      currentFlow: "MAIN_MENU",
      currentStep: null,
      data: new Map(),
      lastUpdated: new Date(),
    };
    await user.save();
    await sendMainMenu(user);
    return;
  }

  await sendWhatsAppMessage(
    user.phoneNumber,
    "Thank you. A doctor will get back to you shortly.\n\nEnter 00 to go back to the main menu."
  );
}

async function handleGeneralEnquiry(user, message) {
  if (message === "00") {
    user.conversationState = {
      currentFlow: "MAIN_MENU",
      currentStep: null,
      data: new Map(),
      lastUpdated: new Date(),
    };
    await user.save();
    await sendMainMenu(user);
    return;
  }

  await sendWhatsAppMessage(
    user.phoneNumber,
    "Thank you. We will address your enquiry as soon as possible.\n\nEnter 00 to go back to the main menu."
  );
}

// Periodic cleanup function
async function cleanupStaleConversationStates() {
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

// Run cleanup every hour
setInterval(cleanupStaleConversationStates, 60 * 60 * 1000);

app.post("/webhook", async (req, res) => {
  const { entry } = req.body;

  if (entry && entry[0].changes && entry[0].changes[0].value.messages) {
    const message = entry[0].changes[0].value.messages[0];
    const from = message.from;
    let messageBody = message.text?.body || "";

    // Handle button responses
    if (message.interactive && message.interactive.button_reply) {
      messageBody = message.interactive.button_reply.title;
    }

    try {
      let user = await User.findOne({ phoneNumber: from });

      if (!user) {
        user = new User({
          phoneNumber: from,
          conversationState: {
            currentFlow: "REGISTRATION",
            currentStep: 0,
            data: new Map(),
            lastUpdated: new Date(),
          },
        });
        await user.save();
        await sendWelcomeMessage(user);
      } else {
        user.lastInteraction = new Date();
        await user.save();

        if (!user.isRegistrationComplete) {
          await handleRegistration(user, messageBody);
        } else {
          await handleConversation(user, messageBody);
        }
      }
    } catch (error) {
      console.error("Error processing webhook:", error);
      // Send a generic error message to the user
      await sendWhatsAppMessage(
        from,
        "Sorry, we encountered an error. Please try again or contact support if the issue persists."
      );
    }
  }

  res.sendStatus(200);
});

// Webhook verification endpoint
app.get("/webhook", (req, res) => {
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
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
