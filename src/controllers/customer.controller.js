const Customer = require("../models/customer.model");

async function getCustomers(req, res, next) {
  try {
    const customers = await Customer.find()
      .populate("priceList", "name")
      .sort({ createdAt: -1 });
    res.status(200).json(customers);
  } catch (err) {
    next(err);
  }
}

async function getCustomer(req, res, next) {
  try {
    const customer = await Customer.findById(req.params.id).populate("priceList", "name");

    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }

    res.status(200).json(customer);
  } catch (err) {
    next(err);
  }
}

async function createCustomer(req, res, next) {
  try {
    const { name, email, company } = req.body;
    const customer = await Customer.create({ name, email, company });
    res.status(201).json(customer);
  } catch (err) {
    next(err);
  }
}

async function updateCustomer(req, res, next) {
  try {
    const { name, email, company } = req.body;
    const customer = await Customer.findByIdAndUpdate(
      req.params.id,
      { name, email, company },
      { new: true, runValidators: true }
    ).populate("priceList", "name");

    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }

    res.status(200).json(customer);
  } catch (err) {
    next(err);
  }
}

async function deleteCustomer(req, res, next) {
  try {
    const customer = await Customer.findByIdAndDelete(req.params.id);

    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }

    res.status(200).json({ message: "Customer deleted" });
  } catch (err) {
    next(err);
  }
}

module.exports = { getCustomers, getCustomer, createCustomer, updateCustomer, deleteCustomer };
