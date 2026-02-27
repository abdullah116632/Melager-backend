class customError extends Error{
    constructor(statusCode, message){
        super(message)
        this.statusCode = statusCode
        this.status = statusCode >= 400 && statusCode < 500 ? "fail" : "error";
        this.isOperational = true;
    }
}

export default customError;