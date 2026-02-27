import customError from "../utils/customErrorClass.js";

export default (error, req, res, next) => {
    error.statusCode = error.statusCode || 500;
    if(process.env.NODE_ENV === "development"){
        devErrorHandler(error, res);
    }else if(process.env.NODE_ENV === "production"){
        if(error.code === 11000){
            const errName = error.keyValue.name
            const message = `There is already a movie with name ${errName}. Please use another name!`
            error = new customError(400, message);
        }
        
        if(error.name === "ValidationError"){
            const err = Object.values(error.errors).map(val => val.message)
            const errMessage = err.join(". ")
            const msg = `Invalid input data : ${errMessage}`;
            error = new customError(400, msg);
        }

        if(error.name === "CastError"){
            const msg = `Invalid values for ${error.path} : ${error.valu}`
            error = new customError(400, msg)
        }

        if(error.name === "TokenExpiredError"){
            const msg = "jwt has expired, please login again"
            error = new customError(401, msg)
        }

        if(error.name === "jsonWebTokenError"){
            const msg = "Invalid token, please login again"
            error = new customError(401, msg)
        }

        prodError(error, res)
    }
}

const devErrorHandler = (error, res) => {
    res.status(error.statusCode).json({
            status: error.status,
            message: error.message,
            stackTrace: error.stack,
            error: error,
    })
}

const prodError = (error, res) => {
    if (error.isOperational) {
      res.status(error.statusCode).json({
        status: error.status,
        message: error.message,
      });
    }else{
      res.status(500).json({
          status: "error",
          message: "Something went wrong, Please try again later"
      })
    }
  };