function login() {
  const loginId = document.getElementById("loginId").value;
  const password = document.getElementById("password").value;
  const errorMsg = document.getElementById("errorMsg");

  if (loginId === "admin" && password === "1234") {
    window.location.href = "subjects.html";
  } else {
    errorMsg.textContent = "Invalid Login ID or Password!";
  }
}

const questions = {
  kinematics: [
    { question: "1. What is the SI unit of speed?", options: ["Kilometer", "Meter per second", "Second", "Meter"], answer: "Meter per second" },
    { question: "2. What does a straight line on a distance-time graph indicate?", options: ["Uniform speed", "Acceleration", "Rest", "Variable speed"], answer: "Uniform speed" },
    { question: "3. Which of the following is a scalar quantity?", options: ["Velocity", "Displacement", "Speed", "Acceleration"], answer: "Speed" },
    { question: "4. What does the area under a speed-time graph represent?", options: ["Speed", "Distance", "Acceleration", "Time"], answer: "Distance" },
    { question: "5. An object moving in a circle at constant speed has velocity that:", options: ["Is constant", "Is zero", "Changes due to direction", "None of these"], answer: "Changes due to direction" }
  ],
  dynamics: [
    { question: "1. Newton's First Law is also known as:", options: ["Law of Acceleration", "Law of Inertia", "Law of Action-Reaction", "Law of Gravity"], answer: "Law of Inertia" },
    { question: "2. The unit of force is:", options: ["Newton", "Joule", "Watt", "Pascal"], answer: "Newton" },
    { question: "3. Which of these is not a contact force?", options: ["Friction", "Tension", "Gravitational", "Normal"], answer: "Gravitational" },
    { question: "4. Action and reaction forces act on:", options: ["Same body", "Different bodies", "Always in same direction", "None"], answer: "Different bodies" },
    { question: "5. Acceleration due to force is inversely proportional to:", options: ["Mass", "Velocity", "Displacement", "Time"], answer: "Mass" }
  ],
  light: [
    { question: "1. Angle of incidence = angle of reflection in:", options: ["Refraction", "Plane mirror", "Concave mirror", "Convex lens"], answer: "Plane mirror" },
    { question: "2. Splitting of white light is:", options: ["Reflection", "Refraction", "Dispersion", "Diffraction"], answer: "Dispersion" },
    { question: "3. Concave mirror is:", options: ["Diverging", "Converging", "Plane", "None"], answer: "Converging" },
    { question: "4. Image by plane mirror is:", options: ["Real", "Virtual and erect", "Inverted", "Magnified"], answer: "Virtual and erect" },
    { question: "5. Light speed is max in:", options: ["Water", "Glass", "Air", "Diamond"], answer: "Air" }
  ],
  sound: [
    { question: "1. Sound travels fastest in:", options: ["Air", "Water", "Steel", "Vacuum"], answer: "Steel" },
    { question: "2. Frequency unit is:", options: ["Hertz", "Decibel", "Meter", "Second"], answer: "Hertz" },
    { question: "3. Pitch depends on:", options: ["Amplitude", "Frequency", "Speed", "Wavelength"], answer: "Frequency" },
    { question: "4. Echo is due to:", options: ["Refraction", "Reflection", "Diffraction", "Interference"], answer: "Reflection" },
    { question: "5. Who can hear ultrasonic?", options: ["Humans", "Dogs", "Bats", "Elephants"], answer: "Bats" }
  ]
};

let currentTopic = '';
let userAnswers = [];

function loadQuestions(topic) {
  currentTopic = topic;
  userAnswers = [];
  const container = document.getElementById("quiz-container");
  const submitBtn = document.getElementById("submit-btn");
  const resultDiv = document.getElementById("result");

  container.innerHTML = '';
  resultDiv.innerHTML = '';
  submitBtn.style.display = "block";

  questions[topic].forEach((q, i) => {
    const block = document.createElement("div");
    block.className = "question-block";
    block.innerHTML = `<p>${q.question}</p>`;
    q.options.forEach(opt => {
      block.innerHTML += `
        <label>
          <input type="radio" name="q${i}" value="${opt}"> ${opt}
        </label><br>`;
    });
    container.appendChild(block);
  });
}

function submitQuiz() {
  let score = 0;
  questions[currentTopic].forEach((q, i) => {
    const selected = document.querySelector(`input[name="q${i}"]:checked`);
    if (selected && selected.value === q.answer) score++;
  });
  document.getElementById("result").innerHTML = `You scored ${score} out of ${questions[currentTopic].length}`;
}
