// Define questions for each topic
const questions = {
  kinematics: [
    {
      question: "1. What is the SI unit of speed?",
      options: ["Kilometer", "Meter per second", "Second", "Meter"],
      answer: "Meter per second"
    },
    {
      question: "2. What does a straight line on a distance-time graph indicate?",
      options: ["Uniform speed", "Acceleration", "Rest", "Variable speed"],
      answer: "Uniform speed"
    },
    {
      question: "3. Which of the following is a scalar quantity?",
      options: ["Velocity", "Displacement", "Speed", "Acceleration"],
      answer: "Speed"
    },
    {
      question: "4. What is the area under a speed-time graph represent?",
      options: ["Speed", "Distance", "Acceleration", "Time"],
      answer: "Distance"
    },
    {
      question: "5. If an object moves in a circle at constant speed, its velocity:",
      options: ["Is constant", "Is zero", "Changes due to direction", "None of these"],
      answer: "Changes due to direction"
    }
  ],
  dynamics: [
    {
      question: "1. Newton's First Law is also known as:",
      options: ["Law of Acceleration", "Law of Inertia", "Law of Action-Reaction", "Law of Gravity"],
      answer: "Law of Inertia"
    },
    {
      question: "2. The unit of force is:",
      options: ["Newton", "Joule", "Watt", "Pascal"],
      answer: "Newton"
    },
    {
      question: "3. Which of the following is not a contact force?",
      options: ["Friction", "Tension", "Gravitational", "Normal"],
      answer: "Gravitational"
    },
    {
      question: "4. Action and reaction forces act on:",
      options: ["Same body", "Different bodies", "Always in same direction", "None of these"],
      answer: "Different bodies"
    },
    {
      question: "5. The acceleration produced by a force is inversely proportional to:",
      options: ["Mass of the body", "Velocity of the body", "Displacement", "Time"],
      answer: "Mass of the body"
    }
  ],
  light: [
    {
      question: "1. The angle of incidence is equal to the angle of reflection in:",
      options: ["Refraction", "Plane mirror", "Concave mirror", "Convex lens"],
      answer: "Plane mirror"
    },
    {
      question: "2. The splitting of white light into its component colors is called:",
      options: ["Reflection", "Refraction", "Dispersion", "Diffraction"],
      answer: "Dispersion"
    },
    {
      question: "3. A concave mirror is also known as:",
      options: ["Diverging mirror", "Converging mirror", "Plane mirror", "None of these"],
      answer: "Converging mirror"
    },
    {
      question: "4. The image formed by a plane mirror is:",
      options: ["Real and inverted", "Virtual and erect", "Real and erect", "Virtual and inverted"],
      answer: "Virtual and erect"
    },
    {
      question: "5. The speed of light is maximum in:",
      options: ["Water", "Glass", "Air", "Diamond"],
      answer: "Air"
    }
  ],
  sound: [
    {
      question: "1. Sound travels fastest in:",
      options: ["Air", "Water", "Steel", "Vacuum"],
      answer: "Steel"
    },
    {
      question: "2. The unit of frequency is:",
      options: ["Hertz", "Decibel", "Meter", "Second"],
      answer: "Hertz"
    },
    {
      question: "3. The pitch of a sound depends on its:",
      options: ["Amplitude", "Frequency", "Speed", "Wavelength"],
      answer: "Frequency"
    },
    {
      question: "4. Echo is heard due to:",
      options: ["Refraction of sound", "Reflection of sound", "Diffraction of sound", "Interference of sound"],
      answer: "Reflection of sound"
    },
    {
      question: "5. Which of the following can hear ultrasonic sounds?",
      options: ["Humans", "Dogs", "Bats", "Elephants"],
      answer: "Bats"
    }
  ]
};

let currentTopic = '';
let userAnswers = [];

function loadQuestions(topic) {
  currentTopic = topic;
  userAnswers = [];
  const quizContainer = document.getElementById('quiz-container');
  const submitBtn = document.getElementById('submit-btn');
  const resultDiv = document.getElementById('result');
  resultDiv.innerHTML = '';
  quizContainer.innerHTML = '';
  const selectedQuestions = questions[topic];
  selectedQuestions.forEach((q, index) => {
    const questionDiv = document.createElement('div');
    questionDiv.classList.add('question-block');
    const questionText = document.createElement('p');
    questionText.textContent = q.question;
    questionDiv.appendChild(questionText);
    q.options.forEach(option => {
      const label = document.createElement('label');
      label.innerHTML = `
        <input type="radio" name="question${index}" value="${option}">
        ${option}
      `;
      questionDiv.appendChild(label);
      questionDiv.appendChild(document.createElement('br'));
    });
    quizContainer.appendChild(questionDiv);
  });
  submitBtn.style.display = 'block';
}

function submitQuiz() {
  const selectedQuestions = questions[currentTopic];
  let score = 0;
  selectedQuestions.forEach((q, index) => {
    const options = document.getElementsByName(`question${index}`);
    options.forEach(option => {
      if (option.checked) {
        userAnswers[index] = option.value;
      }
    });
    if (userAnswers[index] === q.answer) {
      score++;
    }
  });
  const resultDiv = document.getElementById('result');
  resultDiv.innerHTML = `<h3>You scored ${score} out of ${selectedQuestions.length}</h3>`;
}
