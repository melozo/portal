import { Meteor } from 'meteor/meteor';
import { Template } from 'meteor/templating';
import { d3 } from 'd3';
import { MG } from 'metrics-graphics';
// Corresponding html file
import './ux_pages.html';


Template.ux_index_banner.onCreated(() => {});

Template.ux_index_banner.helpers({});

Template.ux_index_banner.onRendered(() => {
  d3.json('data/fake_users1.json', function(data) {
    data = MG.convert.date(data, 'date');
    MG.data_graphic({
      title: "",
      description: "For single line charts, there are two simple ways to change a line color. The first is to change the css (described on the wiki). The other is to specify a color value using color: string or colors: string.",
      data: data,
      full_width: true,
      height: 250,
      right: 40,
      color: '#1189c6',
      target: '#charts',
      x_accessor: 'date',
      y_accessor: 'value'
    });
  });
});

Template.ux_index_banner.events({});


Template.ux_server_connection.onCreated(() => {});

Template.ux_server_connection.helpers({});

Template.ux_server_connection.onRendered(() => {});

Template.ux_server_connection.events({});
