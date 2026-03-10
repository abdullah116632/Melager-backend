import mongoose from 'mongoose';

const WEEKDAY_SHORT_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const dailyMealSchema = new mongoose.Schema(
  {
    breakfast: {
      type: Boolean,
      default: true,
    },
    lunch: {
      type: Boolean,
      default: true,
    },
    dinner: {
      type: Boolean,
      default: true,
    },
    totalMeal: {
      type: Number,
      default: 0,
      min: 0,
      max: 3,
    },
    day: {
      type: String,
      trim: true,
      enum: [
        'Sun',
        'Mon',
        'Tue',
        'Wed',
        'Thu',
        'Fri',
        'Sat',
      ],
    },
  },
  { _id: false }
);

const monthlyMealSchema = new mongoose.Schema(
  {
    consumerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Consumer',
      required: true,
      index: true,
    },
    managerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Manager',
      required: true,
      index: true,
    },
    month: {
      type: Number,
      required: true,
      min: 1,
      max: 12,
    },
    year: {
      type: Number,
      required: true,
      min: 2000,
      max: 2100,
    },
    meals: {
      type: Map,
      of: dailyMealSchema,
      default: {},
      validate: {
        validator(value) {
          const dayKeys = Array.from(value.keys());

          return dayKeys.every((key) => {
            const dayNumber = Number(key);
            return Number.isInteger(dayNumber) && dayNumber >= 1 && dayNumber <= 31;
          });
        },
        message: 'Meal day keys must be numbers from 1 to 31',
      },
    },
    totalsMela: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {
    timestamps: true,
  }
);

monthlyMealSchema.pre('validate', function setDefaultWeekdayFromMonthYear(next) {
  if (!this.meals || !this.month || !this.year) {
    return next();
  }

  this.meals.forEach((meal, key) => {
    if (meal?.day) {
      return;
    }

    const dayNumber = Number(key);

    if (!Number.isInteger(dayNumber) || dayNumber < 1 || dayNumber > 31) {
      return;
    }

    const weekdayIndex = new Date(Date.UTC(this.year, this.month - 1, dayNumber)).getUTCDay();
    meal.day = WEEKDAY_SHORT_NAMES[weekdayIndex];
  });

  next();
});

// One monthly sheet per consumer-manager-month-year.
monthlyMealSchema.index({ consumerId: 1, managerId: 1, month: 1, year: 1 }, { unique: true });

const MonthlyMeal = mongoose.model('MonthlyMeal', monthlyMealSchema);

export default MonthlyMeal;
